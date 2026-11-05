"""Работа с SQLite: подключение и схема БД.

Для MVP используется стандартный sqlite3. Схема написана на переносимом SQL,
переход на PostgreSQL потребует лишь замены типов/плейсхолдеров.
"""
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from .config import DB_PATH

SCHEMA = """
-- Пользователи. Только username + хеш пароля (никаких email/телефонов).
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,            -- bcrypt, соль внутри хеша
    created_at    TEXT    NOT NULL,
    last_seen     TEXT,                         -- обновляется при выходе из сети
    display_name  TEXT,                         -- «ник»: показывается в чатах (логин остаётся для входа)
    bio           TEXT,                         -- описание профиля
    avatar_id     INTEGER REFERENCES media(id) ON DELETE SET NULL,
    privacy       TEXT,                         -- JSON: кто может писать / звонить / слать голосовые
    prefs         TEXT                          -- JSON: тема, обои, быстрая реакция (следуют за аккаунтом)
);

-- Чаты: личные (direct) и групповые (group).
CREATE TABLE IF NOT EXISTS chats (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT    NOT NULL CHECK (type IN ('direct', 'group')),
    title      TEXT,                            -- только для групп
    direct_key TEXT    UNIQUE,                  -- "minId:maxId" — защита от дублей личных чатов
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT    NOT NULL
);

-- Участники чатов (связь многие-ко-многим).
CREATE TABLE IF NOT EXISTS chat_members (
    chat_id   INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role      TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    joined_at TEXT    NOT NULL,
    PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON chat_members(user_id);

-- Загруженные файлы. На диске лежат под случайным именем stored_name.
CREATE TABLE IF NOT EXISTS media (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    original_name TEXT    NOT NULL,
    stored_name   TEXT    NOT NULL UNIQUE,
    mime          TEXT    NOT NULL,
    size          INTEGER NOT NULL,
    kind          TEXT    NOT NULL CHECK (kind IN ('image', 'video', 'voice', 'file')),
    created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_owner ON media(owner_id, id DESC);

-- Сообщения. Текст и/или вложение.
CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id  INTEGER NOT NULL REFERENCES users(id),
    kind       TEXT    NOT NULL DEFAULT 'text'
               CHECK (kind IN ('text', 'image', 'video', 'voice', 'file')),
    text       TEXT,
    media_id   INTEGER REFERENCES media(id) ON DELETE SET NULL,
    meta       TEXT,                           -- JSON: для голосовых {duration, wave}
    cover_id   INTEGER REFERENCES media(id) ON DELETE SET NULL,   -- обложка видео (картинка из media)
    created_at TEXT    NOT NULL
);
-- Основной индекс для пагинации истории: последние N сообщений чата.
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id DESC);

-- Музыка в профиле (как в Telegram): трек = аудиофайл из media + название/исполнитель.
CREATE TABLE IF NOT EXISTS profile_tracks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_id   INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    title      TEXT    NOT NULL,
    artist     TEXT,
    created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracks_user ON profile_tracks(user_id, id);

-- Реакции: одна пара (сообщение, пользователь, эмодзи) — одна строка.
CREATE TABLE IF NOT EXISTS reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT    NOT NULL,
    created_at TEXT    NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
);
"""


def _open(path: Path) -> sqlite3.Connection:
    # check_same_thread=False: FastAPI выполняет sync-зависимости и эндпоинты
    # в разных потоках пула; одно соединение используется только одним запросом.
    conn = sqlite3.connect(path, check_same_thread=False, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")     # в SQLite выключено по умолчанию
    return conn


@contextmanager
def connect(path: Path = DB_PATH):
    """Соединение с автокоммитом при успехе и откатом при ошибке."""
    conn = _open(path)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db(path: Path = DB_PATH) -> None:
    """Создаёт таблицы (идемпотентно) и включает WAL для параллельного чтения."""
    conn = _open(path)
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        # Миграция для баз, созданных на Этапе 1 (без столбца meta)
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(messages)")}
        if "meta" not in cols:
            conn.execute("ALTER TABLE messages ADD COLUMN meta TEXT")
        if "cover_id" not in cols:
            conn.execute("ALTER TABLE messages ADD COLUMN cover_id INTEGER REFERENCES media(id) ON DELETE SET NULL")
        # Миграция Этапа 6: поля профиля
        ucols = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
        for col, ddl in (("display_name", "TEXT"), ("bio", "TEXT"),
                         ("avatar_id", "INTEGER REFERENCES media(id) ON DELETE SET NULL"),
                         ("privacy", "TEXT"), ("prefs", "TEXT")):
            if col not in ucols:
                conn.execute(f"ALTER TABLE users ADD COLUMN {col} {ddl}")
        conn.commit()
    finally:
        conn.close()
