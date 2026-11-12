"""Вход и регистрация по коду из письма: код — одноразовый, хранится только как HMAC."""
import hashlib
import hmac
import re
import secrets
import sqlite3
import time
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import config
from .deps import get_db
from .mail import mail_ready, send_login_code
from .security import create_token, hash_password
from .services import now_iso, serialize_user
from .validators import validate_username

router = APIRouter(prefix="/api/auth/email", tags=["auth"])

EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,24}$")
TICKET_PURPOSE = "email_reg"


def _norm_email(raw: str) -> str:
    email = (raw or "").strip().lower()
    if len(email) > 254 or not EMAIL_RE.match(email):
        raise HTTPException(422, "Введите корректный адрес почты.")
    return email


def _code_hash(email: str, code: str) -> str:
    return hmac.new(config.SECRET_KEY.encode(), f"{email}|{code}".encode(), hashlib.sha256).hexdigest()


class EmailRequest(BaseModel):
    email: str = Field(max_length=254)


class EmailVerify(BaseModel):
    email: str = Field(max_length=254)
    code: str = Field(max_length=12)


class EmailRegister(BaseModel):
    ticket: str = Field(max_length=2048)
    username: str = Field(max_length=64)


@router.post("/request")
def request_code(data: EmailRequest, conn: sqlite3.Connection = Depends(get_db)):
    email = _norm_email(data.email)
    if not mail_ready():
        raise HTTPException(503, "Вход по почте временно недоступен: почта не настроена.")
    now = time.time()
    last = conn.execute("SELECT created_at FROM email_codes WHERE email = ? ORDER BY id DESC LIMIT 1", (email,)).fetchone()
    if last and now - last["created_at"] < config.EMAIL_CODE_COOLDOWN_SEC:
        wait = int(config.EMAIL_CODE_COOLDOWN_SEC - (now - last["created_at"])) + 1
        raise HTTPException(429, f"Код уже отправлен. Повторить можно через {wait} с.")
    code = f"{secrets.randbelow(1_000_000):06d}"
    conn.execute("UPDATE email_codes SET used = 1 WHERE email = ? AND used = 0", (email,))
    conn.execute("INSERT INTO email_codes (email, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)",
                 (email, _code_hash(email, code), now, now + config.EMAIL_CODE_TTL_SEC))
    conn.commit()
    try:
        send_login_code(email, code)
    except Exception:                              # SMTP недоступен или не настроен
        conn.execute("UPDATE email_codes SET used = 1 WHERE email = ? AND used = 0", (email,))
        conn.commit()
        raise HTTPException(503, "Не удалось отправить письмо. Попробуйте позже.")
    # Ответ одинаковый, есть ли такой адрес в системе — чтобы не выдавать аккаунты.
    return {"ok": True, "ttl": config.EMAIL_CODE_TTL_SEC, "cooldown": config.EMAIL_CODE_COOLDOWN_SEC}


@router.post("/verify")
def verify_code(data: EmailVerify, conn: sqlite3.Connection = Depends(get_db)):
    email = _norm_email(data.email)
    code = (data.code or "").strip()
    row = conn.execute(
        "SELECT * FROM email_codes WHERE email = ? AND used = 0 ORDER BY id DESC LIMIT 1", (email,)).fetchone()
    if not row or time.time() > row["expires_at"]:
        raise HTTPException(400, "Код истёк или не запрашивался. Запросите новый.")
    if row["tries"] >= config.EMAIL_CODE_MAX_TRIES:
        conn.execute("UPDATE email_codes SET used = 1 WHERE id = ?", (row["id"],)); conn.commit()
        raise HTTPException(429, "Слишком много неверных попыток. Запросите новый код.")
    if not hmac.compare_digest(row["code_hash"], _code_hash(email, code)):
        conn.execute("UPDATE email_codes SET tries = tries + 1 WHERE id = ?", (row["id"],)); conn.commit()
        left = config.EMAIL_CODE_MAX_TRIES - row["tries"] - 1
        raise HTTPException(400, f"Неверный код. Осталось попыток: {left}.")
    conn.execute("UPDATE email_codes SET used = 1 WHERE id = ?", (row["id"],)); conn.commit()

    user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if user:                                      # почта уже привязана — входим сразу
        return {"status": "ok", "token": create_token(user["id"]), "token_type": "bearer", "user": serialize_user(user)}
    # Новый адрес: выдаём короткоживущий билет, с ним выбирают имя пользователя
    now = datetime.now(timezone.utc)
    ticket = jwt.encode({"purpose": TICKET_PURPOSE, "email": email, "iat": now,
                         "exp": now + timedelta(seconds=config.EMAIL_TICKET_TTL_SEC)},
                        config.SECRET_KEY, algorithm=config.JWT_ALGORITHM)
    return {"status": "need_username", "ticket": ticket}


@router.post("/register", status_code=201)
def register_with_email(data: EmailRegister, conn: sqlite3.Connection = Depends(get_db)):
    try:
        payload = jwt.decode(data.ticket, config.SECRET_KEY, algorithms=[config.JWT_ALGORITHM])
    except jwt.PyJWTError:
        raise HTTPException(400, "Подтверждение почты устарело. Запросите код заново.")
    if payload.get("purpose") != TICKET_PURPOSE:
        raise HTTPException(400, "Подтверждение почты устарело. Запросите код заново.")
    email = payload["email"]
    username = (data.username or "").strip()
    errors = validate_username(username)
    if errors:
        raise HTTPException(422, detail={"message": "Проверьте имя пользователя.", "username_errors": errors, "password_errors": []})
    if conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
        raise HTTPException(409, "Это имя пользователя уже занято.")
    if conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
        raise HTTPException(409, "Эта почта уже привязана к аккаунту. Войдите по коду.")
    # Пароля у такого аккаунта нет: вход только по почте (пароль можно задать позже).
    cur = conn.execute(
        "INSERT INTO users (username, password_hash, created_at, email) VALUES (?, ?, ?, ?)",
        (username, hash_password(secrets.token_urlsafe(32)), now_iso(), email))
    conn.commit()
    user = conn.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
    return {"status": "ok", "token": create_token(user["id"]), "token_type": "bearer", "user": serialize_user(user)}
