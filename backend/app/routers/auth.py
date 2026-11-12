"""Текущий пользователь. Вход и регистрация — по почте, см. email_auth.py."""
import sqlite3

from fastapi import APIRouter, Depends

from ..deps import get_current_user, get_db
from ..services import serialize_profile

router = APIRouter(prefix="/api/auth", tags=["auth"])


# Вход и регистрация — только по коду из письма (см. email_auth.py).
# Вход по имени пользователя и паролю отключён.


@router.get("/me")
def me(user: sqlite3.Row = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)):
    # Свой профиль целиком: включая приватность и настройки (тема, обои, быстрая реакция)
    return serialize_profile(conn, user, own=True)
