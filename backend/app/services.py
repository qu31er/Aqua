"""Бизнес-логика работы с чатами и сообщениями.

Используется и REST-роутерами, и WebSocket-обработчиком, чтобы правила
(проверка членства, лимиты, сериализация) были в одном месте.
"""
import json
import sqlite3
from datetime import datetime, timezone

from . import config
from .realtime import manager


class ServiceError(Exception):
    """Ошибка бизнес-логики с HTTP-подобным статусом."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


# --- Пользователи --------------------------------------------------------------
def _json(value, default):
    try:
        data = json.loads(value) if value else None
    except ValueError:
        data = None
    return data if isinstance(data, dict) else default


def get_privacy(row: sqlite3.Row) -> dict:
    """Настройки приватности с значениями по умолчанию для отсутствующих ключей."""
    saved = _json(row["privacy"], {})
    return {f: saved.get(f) if saved.get(f) in config.PRIVACY_VALUES else "everyone" for f in config.PRIVACY_FIELDS}


def get_prefs(row: sqlite3.Row) -> dict:
    prefs = _json(row["prefs"], {})
    if prefs.get("quick_reaction") not in config.ALLOWED_REACTIONS:
        prefs["quick_reaction"] = config.DEFAULT_QUICK_REACTION
    return prefs


def avatar_ref(media_id: int | None, preset: str | None = None) -> dict | None:
    """Аватар: своя картинка (media) или системная заготовка (preset — имя файла assets/avatars/<preset>.svg)."""
    if media_id:
        return {"id": media_id, "url": f"/api/media/{media_id}"}
    if preset in config.AVATAR_PRESETS:
        return {"preset": preset}
    return None


def serialize_user(row: sqlite3.Row) -> dict:
    """Публичные данные пользователя (видны собеседникам)."""
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"] or row["username"],
        "avatar": avatar_ref(row["avatar_id"], row["avatar_preset"]),
        "online": manager.is_online(row["id"]),
        "last_seen": row["last_seen"],
    }


def serialize_tracks(conn: sqlite3.Connection, user_id: int) -> list[dict]:
    rows = conn.execute(
        """SELECT t.id, t.title, t.artist, t.media_id, md.size FROM profile_tracks t
           JOIN media md ON md.id = t.media_id WHERE t.user_id = ? ORDER BY t.id""", (user_id,)).fetchall()
    return [{"id": r["id"], "title": r["title"], "artist": r["artist"], "size": r["size"],
             "url": f"/api/media/{r['media_id']}"} for r in rows]


def is_contact(conn: sqlite3.Connection, owner_id: int, other_id: int) -> bool:
    return conn.execute("SELECT 1 FROM contacts WHERE user_id = ? AND contact_id = ?", (owner_id, other_id)).fetchone() is not None


def is_blocked(conn: sqlite3.Connection, owner_id: int, other_id: int) -> bool:
    """True, если owner заблокировал other."""
    return conn.execute("SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?", (owner_id, other_id)).fetchone() is not None


def serialize_profile(conn: sqlite3.Connection, row: sqlite3.Row, *, own: bool, viewer_id: int | None = None) -> dict:
    """Профиль целиком. Приватность и настройки отдаём только владельцу; для чужого — признаки «контакт/заблокирован»."""
    data = {**serialize_user(row), "bio": row["bio"] or "", "tracks": serialize_tracks(conn, row["id"])}
    if own:
        data["privacy"] = get_privacy(row)
        data["prefs"] = get_prefs(row)
    elif viewer_id is not None:
        data["is_contact"] = is_contact(conn, viewer_id, row["id"])
        data["is_blocked"] = is_blocked(conn, viewer_id, row["id"])
    return data


# --- Чаты ------------------------------------------------------------------------
def member_ids(conn: sqlite3.Connection, chat_id: int) -> list[int]:
    rows = conn.execute("SELECT user_id FROM chat_members WHERE chat_id = ?", (chat_id,))
    return [r["user_id"] for r in rows]


def require_member(conn: sqlite3.Connection, chat_id: int, user_id: int) -> None:
    """404 вместо 403, чтобы не раскрывать существование чужих чатов."""
    row = conn.execute(
        "SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?", (chat_id, user_id)
    ).fetchone()
    if row is None:
        raise ServiceError(404, "Чат не найден.")


def contact_ids(conn: sqlite3.Connection, user_id: int) -> list[int]:
    """Все, кто состоит с пользователем хотя бы в одном чате (для рассылки статуса)."""
    rows = conn.execute(
        """SELECT DISTINCT m2.user_id FROM chat_members m1
           JOIN chat_members m2 ON m2.chat_id = m1.chat_id
           WHERE m1.user_id = ? AND m2.user_id != ?""",
        (user_id, user_id),
    )
    return [r["user_id"] for r in rows]


def serialize_chat(conn: sqlite3.Connection, chat_id: int, viewer_id: int) -> dict:
    chat = conn.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone()
    members = conn.execute(
        """SELECT u.* FROM chat_members cm
           JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = ? ORDER BY u.username""",
        (chat_id,),
    ).fetchall()
    # У личного чата заголовок — имя собеседника.
    title = chat["title"]
    if chat["type"] == "direct":
        other = next((m for m in members if m["id"] != viewer_id), None)
        title = (other["display_name"] or other["username"]) if other else "—"
    last = conn.execute(
        "SELECT id FROM messages WHERE chat_id = ? "
        "AND id NOT IN (SELECT message_id FROM message_hidden WHERE user_id = ?) ORDER BY id DESC LIMIT 1",
        (chat_id, viewer_id),
    ).fetchone()
    return {
        "id": chat["id"],
        "type": chat["type"],
        "title": title,
        "created_at": chat["created_at"],
        "members": [serialize_user(m) for m in members],
        "last_message": get_message(conn, last["id"]) if last else None,
    }


def list_chats(conn: sqlite3.Connection, user_id: int) -> list[dict]:
    """Чаты пользователя, сверху — с самым свежим сообщением."""
    rows = conn.execute(
        """SELECT c.id FROM chats c
           JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = ?
           ORDER BY COALESCE((SELECT MAX(id) FROM messages WHERE chat_id = c.id), 0) DESC,
                    c.id DESC""",
        (user_id,),
    ).fetchall()
    return [serialize_chat(conn, r["id"], user_id) for r in rows]


def _user_by_name(conn: sqlite3.Connection, username: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM users WHERE username = ?", (username.strip(),)).fetchone()
    if row is None:
        raise ServiceError(404, f"Пользователь «{username}» не найден.")
    return row


def create_direct_chat(conn: sqlite3.Connection, me: int, username: str) -> tuple[int, bool]:
    """Личный чат. Возвращает (chat_id, создан_ли_новый)."""
    other = _user_by_name(conn, username)
    if other["id"] == me:
        raise ServiceError(400, "Нельзя создать чат с самим собой.")
    key = f"{min(me, other['id'])}:{max(me, other['id'])}"
    existing = conn.execute("SELECT id FROM chats WHERE direct_key = ?", (key,)).fetchone()
    if existing:
        return existing["id"], False
    ts = now_iso()
    cur = conn.execute(
        "INSERT INTO chats (type, direct_key, created_by, created_at) VALUES ('direct', ?, ?, ?)",
        (key, me, ts),
    )
    chat_id = cur.lastrowid
    conn.executemany(
        "INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
        [(chat_id, me, ts), (chat_id, other["id"], ts)],
    )
    return chat_id, True


def create_group_chat(
    conn: sqlite3.Connection, me: int, title: str, usernames: list[str]
) -> int:
    title = (title or "").strip()
    if not title:
        raise ServiceError(400, "Укажите название группы.")
    ids = {me}
    for name in usernames:
        ids.add(_user_by_name(conn, name)["id"])
    ts = now_iso()
    cur = conn.execute(
        "INSERT INTO chats (type, title, created_by, created_at) VALUES ('group', ?, ?, ?)",
        (title, me, ts),
    )
    chat_id = cur.lastrowid
    conn.executemany(
        "INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)",
        [(chat_id, uid, "owner" if uid == me else "member", ts) for uid in ids],
    )
    return chat_id


# --- Сообщения -----------------------------------------------------------------
_MESSAGE_SELECT = """
    SELECT m.id, m.chat_id, m.sender_id, u.username AS sender_username,
           u.display_name AS sender_display, u.avatar_id AS sender_avatar, u.avatar_preset AS sender_preset, m.kind, m.text,
           m.media_id, m.meta, m.cover_id, m.created_at, m.edited_at, md.original_name, md.mime, md.size
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN media md ON md.id = m.media_id
"""


def serialize_message(row: sqlite3.Row) -> dict:
    media = None
    if row["media_id"] is not None:
        media = {
            "id": row["media_id"],
            "url": f"/api/media/{row['media_id']}",
            "name": row["original_name"],
            "mime": row["mime"],
            "size": row["size"],
        }
    return {
        "id": row["id"],
        "chat_id": row["chat_id"],
        "sender": {"id": row["sender_id"], "username": row["sender_username"],
                   "display_name": row["sender_display"] or row["sender_username"],
                   "avatar": avatar_ref(row["sender_avatar"], row["sender_preset"])},
        "kind": row["kind"],
        "text": row["text"],
        "media": media,
        "meta": json.loads(row["meta"]) if row["meta"] else None,   # голосовые: {duration, wave}
        "cover": {"id": row["cover_id"], "url": f"/api/media/{row['cover_id']}"} if row["cover_id"] else None,
        "reactions": [],                                            # заполняет attach_reactions
        "created_at": row["created_at"],
        "edited_at": row["edited_at"],
    }


def attach_reactions(conn: sqlite3.Connection, messages: list[dict]) -> list[dict]:
    """Одним запросом добавляет к сообщениям сгруппированные реакции: [{emoji, count, users}]."""
    if not messages:
        return messages
    ids = [m["id"] for m in messages]
    rows = conn.execute(
        f"SELECT message_id, emoji, user_id FROM reactions "
        f"WHERE message_id IN ({','.join('?' * len(ids))}) ORDER BY created_at, rowid",
        ids,
    )
    grouped: dict[int, dict[str, list[int]]] = {}
    for r in rows:
        grouped.setdefault(r["message_id"], {}).setdefault(r["emoji"], []).append(r["user_id"])
    for m in messages:
        m["reactions"] = [
            {"emoji": e, "count": len(u), "users": u} for e, u in grouped.get(m["id"], {}).items()
        ]
    return messages


def get_reactions(conn: sqlite3.Connection, message_id: int) -> list[dict]:
    return attach_reactions(conn, [{"id": message_id}])[0]["reactions"]


def toggle_reaction(
    conn: sqlite3.Connection, message_id: int, user_id: int, emoji: str
) -> tuple[int, list[dict]]:
    """Ставит реакцию или снимает, если она уже стоит. Возвращает (chat_id, реакции сообщения)."""
    if emoji not in config.ALLOWED_REACTIONS:
        raise ServiceError(400, "Такая реакция недоступна.")
    row = conn.execute("SELECT chat_id FROM messages WHERE id = ?", (message_id,)).fetchone()
    if row is None:
        raise ServiceError(404, "Сообщение не найдено.")
    require_member(conn, row["chat_id"], user_id)
    removed = conn.execute(
        "DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
        (message_id, user_id, emoji),
    ).rowcount
    if not removed:
        conn.execute(
            "INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)",
            (message_id, user_id, emoji, now_iso()),
        )
    return row["chat_id"], get_reactions(conn, message_id)


def get_message(conn: sqlite3.Connection, message_id: int) -> dict:
    row = conn.execute(_MESSAGE_SELECT + " WHERE m.id = ?", (message_id,)).fetchone()
    return attach_reactions(conn, [serialize_message(row)])[0]


def get_history(
    conn: sqlite3.Connection, chat_id: int, before_id: int | None, limit: int, viewer_id: int | None = None
) -> list[dict]:
    """Страница истории: последние `limit` сообщений старше `before_id`, по возрастанию.
    Сообщения, скрытые зрителем («удалить у себя»), не показываем."""
    params: list = [chat_id]
    where = " WHERE m.chat_id = ?"
    if viewer_id is not None:
        where += " AND m.id NOT IN (SELECT message_id FROM message_hidden WHERE user_id = ?)"
        params.append(viewer_id)
    if before_id is not None:
        where += " AND m.id < ?"
        params.append(before_id)
    rows = conn.execute(
        _MESSAGE_SELECT + where + " ORDER BY m.id DESC LIMIT ?", (*params, limit)
    ).fetchall()
    return attach_reactions(conn, [serialize_message(r) for r in reversed(rows)])


def validate_meta(kind: str, meta) -> dict | None:
    """Метаданные принимаем только у голосовых: длительность и форма волны (для отрисовки без декодирования аудио)."""
    if meta is None:
        return None
    bad = ServiceError(400, "Неверные данные голосового сообщения.")
    if kind != "voice" or not isinstance(meta, dict):
        raise bad
    duration, wave = meta.get("duration"), meta.get("wave")
    if isinstance(duration, bool) or not isinstance(duration, (int, float)) \
            or not 0 < duration <= config.MAX_VOICE_SECONDS:
        raise bad
    if not isinstance(wave, list) or not 1 <= len(wave) <= 100 or any(
        isinstance(v, bool) or not isinstance(v, int) or not 0 <= v <= 100 for v in wave
    ):
        raise bad
    return {"duration": round(float(duration), 2), "wave": wave}


def _has_written_to(conn: sqlite3.Connection, chat_id: int, author: int) -> bool:
    return conn.execute("SELECT 1 FROM messages WHERE chat_id = ? AND sender_id = ? LIMIT 1",
                        (chat_id, author)).fetchone() is not None


def enforce_privacy(conn: sqlite3.Connection, chat_id: int, sender_id: int, *, voice: bool) -> None:
    """Личные чаты: учитываем, кому получатель разрешил писать / слать голосовые.

    «contacts» = получатель добавил отправителя в контакты или уже сам писал ему в этом чате.
    Заблокированный пользователь писать не может вовсе.
    На группы и каналы настройки не действуют.
    """
    chat = conn.execute("SELECT type FROM chats WHERE id = ?", (chat_id,)).fetchone()
    if chat is None or chat["type"] != "direct":
        return
    other = conn.execute(
        "SELECT u.* FROM chat_members cm JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = ? AND cm.user_id != ?",
        (chat_id, sender_id)).fetchone()
    if other is None:
        return
    if is_blocked(conn, sender_id, other["id"]):
        raise ServiceError(403, "Вы заблокировали этого пользователя. Разблокируйте его, чтобы писать.")
    if is_blocked(conn, other["id"], sender_id):
        raise ServiceError(403, "Вы не можете писать этому пользователю.")
    privacy = get_privacy(other)
    rules = [("who_can_write", "Пользователь ограничил, кто может ему писать.")]
    if voice:
        rules.append(("who_can_voice", "Пользователь не принимает голосовые сообщения от вас."))
    for field, message in rules:
        value = privacy[field]
        if value == "nobody" or (value == "contacts" and not (is_contact(conn, other["id"], sender_id)
                                                              or _has_written_to(conn, chat_id, other["id"]))):
            raise ServiceError(403, message)


def create_message(
    conn: sqlite3.Connection,
    chat_id: int,
    sender_id: int,
    text: str | None,
    media_id: int | None,
    meta: dict | None = None,
    cover_id: int | None = None,
) -> dict:
    """Проверяет права и лимиты, сохраняет сообщение, возвращает его в виде dict."""
    require_member(conn, chat_id, sender_id)
    text = (text or "").strip() or None
    enforce_privacy(conn, chat_id, sender_id, voice=False)
    if text is None and media_id is None:
        raise ServiceError(400, "Сообщение пустое.")
    if text and len(text) > config.MAX_MESSAGE_LENGTH:
        raise ServiceError(400, f"Сообщение длиннее {config.MAX_MESSAGE_LENGTH} символов.")

    kind = "text"
    if media_id is not None:
        media = conn.execute(
            "SELECT owner_id, kind FROM media WHERE id = ?", (media_id,)
        ).fetchone()
        # Отправлять можно только свои файлы.
        if media is None or media["owner_id"] != sender_id:
            raise ServiceError(400, "Вложение не найдено.")
        kind = media["kind"]

    if kind == "voice":
        enforce_privacy(conn, chat_id, sender_id, voice=True)
    meta = validate_meta(kind, meta)
    if cover_id is not None:
        # Обложка — только у видео, только своя картинка
        cover = conn.execute("SELECT owner_id, kind FROM media WHERE id = ?", (cover_id,)).fetchone()
        if kind != "video" or cover is None or cover["owner_id"] != sender_id or cover["kind"] != "image":
            raise ServiceError(400, "Неверная обложка видео.")
    cur = conn.execute(
        "INSERT INTO messages (chat_id, sender_id, kind, text, media_id, meta, cover_id, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (chat_id, sender_id, kind, text, media_id, json.dumps(meta) if meta else None, cover_id, now_iso()),
    )
    return get_message(conn, cur.lastrowid)


# --- Медиа -----------------------------------------------------------------------
def can_access_media(conn: sqlite3.Connection, media_id: int, user_id: int) -> bool:
    """Файл доступен владельцу и участникам чатов, куда он (или он как обложка видео) был отправлен."""
    row = conn.execute(
        """SELECT 1 FROM media WHERE id = ? AND owner_id = ?
           UNION
           SELECT 1 FROM messages m
           JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
           WHERE m.media_id = ? OR m.cover_id = ?
           UNION
           SELECT 1 FROM users WHERE avatar_id = ?
           UNION
           SELECT 1 FROM profile_tracks WHERE media_id = ?""",
        (media_id, user_id, user_id, media_id, media_id, media_id, media_id),
    ).fetchone()
    return row is not None


def media_summary(conn: sqlite3.Connection, user_id: int) -> dict:
    """Сколько файлов каждого типа загрузил пользователь — «папки» файлового менеджера."""
    counts = {"image": 0, "video": 0, "voice": 0, "file": 0}
    for r in conn.execute("SELECT kind, COUNT(*) AS n FROM media WHERE owner_id = ? GROUP BY kind", (user_id,)):
        counts[r["kind"]] = r["n"]
    return counts


# --- Изменение и удаление сообщений -----------------------------------------------
def _own_or_member_message(conn: sqlite3.Connection, message_id: int, user_id: int) -> sqlite3.Row:
    """Сообщение, к которому у пользователя есть доступ (он участник чата). Иначе 404, чтобы не раскрывать id."""
    row = conn.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
    if row is None or conn.execute(
        "SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?", (row["chat_id"], user_id)
    ).fetchone() is None:
        raise ServiceError(404, "Сообщение не найдено.")
    return row


def edit_message(conn: sqlite3.Connection, message_id: int, user_id: int, text: str | None) -> dict:
    """Меняет текст (или подпись к медиа) своего сообщения. Голосовые изменить нельзя."""
    row = _own_or_member_message(conn, message_id, user_id)
    if row["sender_id"] != user_id:
        raise ServiceError(403, "Можно изменять только свои сообщения.")
    if row["kind"] == "voice":
        raise ServiceError(400, "Голосовое сообщение нельзя изменить.")
    text = (text or "").strip()
    if len(text) > config.MAX_MESSAGE_LENGTH:
        raise ServiceError(400, f"Сообщение длиннее {config.MAX_MESSAGE_LENGTH} символов.")
    if not text and row["kind"] == "text":
        raise ServiceError(400, "Сообщение не может быть пустым.")
    conn.execute("UPDATE messages SET text = ?, edited_at = ? WHERE id = ?", (text or None, now_iso(), message_id))
    return attach_reactions(conn, [get_message(conn, message_id)])[0]


def delete_message(conn: sqlite3.Connection, message_id: int, user_id: int, scope: str) -> int:
    """scope='all' — удалить у всех (только автор); scope='me' — скрыть только у себя. Возвращает chat_id."""
    row = _own_or_member_message(conn, message_id, user_id)
    if scope == "all":
        if row["sender_id"] != user_id:
            raise ServiceError(403, "Удалить у всех можно только свои сообщения.")
        conn.execute("DELETE FROM messages WHERE id = ?", (message_id,))      # реакции и «скрытия» уйдут каскадом
    elif scope == "me":
        conn.execute("INSERT OR IGNORE INTO message_hidden (message_id, user_id) VALUES (?, ?)", (message_id, user_id))
    else:
        raise ServiceError(422, "scope: all или me.")
    return row["chat_id"]


def last_message_for(conn: sqlite3.Connection, chat_id: int, viewer_id: int) -> dict | None:
    """Актуальное «последнее сообщение» чата для конкретного зрителя (после удаления/скрытия)."""
    return serialize_chat(conn, chat_id, viewer_id)["last_message"]
