"""Тесты Этапа 1. Запуск: из папки backend/  ->  pytest -q"""
import os
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
# Тестовая БД и данные — во временной папке, bcrypt с минимальной стоимостью.
os.environ["AQUA_DATA_DIR"] = tempfile.mkdtemp(prefix="aqua-test-")
os.environ["AQUA_BCRYPT_ROUNDS"] = "4"

from app.validators import validate_password, validate_username  # noqa: E402


# --- Валидация (без внешних зависимостей) -------------------------------------
@pytest.mark.parametrize("pwd", ["abcdefg1", "Passw0rdXYZ", "пароль-a1-b2c3"])
def test_password_ok(pwd):
    assert validate_password(pwd) == []


@pytest.mark.parametrize(
    "pwd, fragment",
    [
        ("abc1", "не менее 8"),
        ("12345678", "строчную"),
        ("ABCDEFG1", "строчную"),       # заглавные не считаются
        ("пароль123", "строчную"),      # кириллица не считается латиницей
        ("abcdefgh", "цифру"),
        ("a1" * 40, "слишком длинный"),
    ],
)
def test_password_bad(pwd, fragment):
    assert any(fragment in e for e in validate_password(pwd))


def test_username():
    assert validate_username("alice_01") == []
    assert validate_username("ab") and validate_username("a b c") and validate_username("имя")


# --- API (нужны fastapi и httpx) -------------------------------------------------
@pytest.fixture(scope="module")
def client():
    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as c:
        yield c


def _register(client, name, pwd="secret123"):
    r = client.post("/api/auth/register", json={"username": name, "password": pwd})
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}, r.json()["user"]


def test_register_rejects_weak_password(client):
    r = client.post("/api/auth/register", json={"username": "weak", "password": "short"})
    assert r.status_code == 422
    assert r.json()["detail"]["password_errors"]


def test_login_flow_and_duplicates(client):
    _register(client, "Alice")
    assert client.post("/api/auth/register", json={"username": "alice", "password": "secret123"}).status_code == 409
    assert client.post("/api/auth/login", json={"username": "ALICE", "password": "secret123"}).status_code == 200
    assert client.post("/api/auth/login", json={"username": "alice", "password": "wrong"}).status_code == 401


def test_chat_message_media_flow(client):
    ha, a = _register(client, "ann")
    hb, b = _register(client, "bob")
    hc, _ = _register(client, "carl")

    chat = client.post("/api/chats", headers=ha, json={"type": "direct", "username": "bob"}).json()
    again = client.post("/api/chats", headers=ha, json={"type": "direct", "username": "bob"}).json()
    assert chat["id"] == again["id"]                      # дубль личного чата не создаётся

    m = client.post(f"/api/chats/{chat['id']}/messages", headers=ha, json={"text": "привет"})
    assert m.status_code == 201
    hist = client.get(f"/api/chats/{chat['id']}/messages", headers=hb).json()
    assert [x["text"] for x in hist] == ["привет"]
    assert client.get(f"/api/chats/{chat['id']}/messages", headers=hc).status_code == 404  # чужой чат

    up = client.post("/api/media", headers=ha, files={"file": ("p.png", b"\x89PNG\r\n" + b"0" * 50, "image/png")})
    assert up.status_code == 201
    mid = up.json()["id"]
    assert client.get(f"/api/media/{mid}", headers=hc).status_code == 404   # ещё никому не отправлен
    client.post(f"/api/chats/{chat['id']}/messages", headers=ha, json={"media_id": mid})
    assert client.get(f"/api/media/{mid}", headers=hb).status_code == 200
    assert client.get(f"/api/media/{mid}", headers=hc).status_code == 404
    bad = client.post("/api/media", headers=ha, files={"file": ("x.svg", b"<svg/>", "image/svg+xml")})
    assert bad.status_code == 415


def test_websocket_message_and_typing(client):
    ha, a = _register(client, "wsann")
    hb, b = _register(client, "wsbob")
    chat = client.post("/api/chats", headers=ha, json={"type": "direct", "username": "wsbob"}).json()
    tok = lambda h: h["Authorization"].split()[1]

    with client.websocket_connect("/ws") as wa, client.websocket_connect("/ws") as wb:
        wa.send_json({"type": "auth", "token": tok(ha)})
        assert wa.receive_json()["type"] == "ready"
        wb.send_json({"type": "auth", "token": tok(hb)})
        assert wb.receive_json()["type"] == "ready"

        wa.send_json({"type": "typing", "chat_id": chat["id"], "is_typing": True})
        # wb может сначала получить presence — пропускаем служебные события
        events = [wb.receive_json() for _ in range(2)]
        assert any(e["type"] == "typing" and e["is_typing"] for e in events)

        wa.send_json({"type": "message", "chat_id": chat["id"], "text": "hi", "client_id": "c1"})
        got = next(e for e in (wb.receive_json() for _ in range(3)) if e["type"] == "message")
        assert got["message"]["text"] == "hi"
