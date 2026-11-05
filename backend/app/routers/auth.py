"""Регистрация и вход (только username + пароль)."""
import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..deps import get_current_user, get_db
from ..security import (DUMMY_HASH, create_token, hash_password, login_limiter,
                        verify_password)
from ..services import now_iso, serialize_profile, serialize_user
from ..validators import validate_password, validate_username

router = APIRouter(prefix="/api/auth", tags=["auth"])


class Credentials(BaseModel):
    # Жёсткие лимиты длины — только защита от огромных тел запроса;
    # содержательная проверка выполняется validators.py и даёт понятные ошибки.
    username: str = Field(max_length=64)
    password: str = Field(max_length=256)


def _auth_response(user: sqlite3.Row) -> dict:
    return {"token": create_token(user["id"]), "token_type": "bearer", "user": serialize_user(user)}


@router.post("/register", status_code=201)
def register(data: Credentials, conn: sqlite3.Connection = Depends(get_db)):
    username = data.username.strip()
    errors = validate_username(username)
    pwd_errors = validate_password(data.password)
    if errors or pwd_errors:
        # 422 с понятным списком проблем — фронтенд показывает их под полями.
        raise HTTPException(
            422,
            detail={
                "message": "Проверьте введённые данные.",
                "username_errors": errors,
                "password_errors": pwd_errors,
            },
        )
    if conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
        raise HTTPException(409, "Это имя пользователя уже занято.")

    cur = conn.execute(
        "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
        (username, hash_password(data.password), now_iso()),
    )
    user = conn.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _auth_response(user)


@router.post("/login")
def login(data: Credentials, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    key = f"{request.client.host if request.client else '-'}|{data.username.strip().lower()}"
    if login_limiter.is_blocked(key):
        raise HTTPException(429, "Слишком много попыток входа. Попробуйте через несколько минут.")

    user = conn.execute(
        "SELECT * FROM users WHERE username = ?", (data.username.strip(),)
    ).fetchone()
    # Проверяем хеш всегда (даже для несуществующего логина) — одинаковое время ответа.
    ok = verify_password(data.password, user["password_hash"] if user else DUMMY_HASH)
    if not user or not ok:
        login_limiter.register_fail(key)
        raise HTTPException(401, "Неверное имя пользователя или пароль.")

    login_limiter.reset(key)
    return _auth_response(user)


@router.get("/me")
def me(user: sqlite3.Row = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)):
    # Свой профиль целиком: включая приватность и настройки (тема, обои, быстрая реакция)
    return serialize_profile(conn, user, own=True)
