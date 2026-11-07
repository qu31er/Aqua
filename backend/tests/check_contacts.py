# Блокировка, контакты и приватность на SQLite без FastAPI: python3 -I backend/tests/check_contacts.py
import sys, types, os, tempfile, json
os.environ["AQUA_DATA_DIR"] = tempfile.mkdtemp()
fa = types.ModuleType("fastapi"); fa.WebSocket = object; sys.modules["fastapi"] = fa
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
from app import config, database, services
from app.services import ServiceError
database.init_db(); database.init_db()
c = database._open(config.DB_PATH); ts = services.now_iso()
for n in ("a", "b"): c.execute("INSERT INTO users (username,password_hash,created_at) VALUES (?,?,?)", (n, "x", ts))
chat, _ = services.create_direct_chat(c, 1, "b")
def fails(sender, text="x"):
    try: services.create_message(c, chat, sender, text, None); return None
    except ServiceError as e: return e.status
assert fails(1) is None and fails(2) is None
# a заблокировал b: ни a, ни b писать не могут
c.execute("INSERT INTO blocks VALUES (1,2,?)", (ts,))
assert fails(2) == 403 and fails(1) == 403
p = services.serialize_profile(c, c.execute("SELECT * FROM users WHERE id=2").fetchone(), own=False, viewer_id=1)
assert p["is_blocked"] is True and p["is_contact"] is False
c.execute("DELETE FROM blocks"); assert fails(2) is None
# приватность «contacts»: b разрешил писать только контактам; a не пишет b → нельзя; добавил в контакты → можно
chat2_users = c.execute("INSERT INTO users (username,password_hash,created_at) VALUES ('c','x',?)", (ts,)).lastrowid
chat2, _ = services.create_direct_chat(c, 3, "b")
c.execute("UPDATE users SET privacy=? WHERE id=2", (json.dumps({**services.get_privacy(c.execute('SELECT * FROM users WHERE id=2').fetchone()), "who_can_write": "contacts"}),))
try: services.create_message(c, chat2, 3, "hi", None); raise SystemExit("должно быть запрещено")
except ServiceError as e: assert e.status == 403
c.execute("INSERT INTO contacts VALUES (2,3,?)", (ts,))
assert services.create_message(c, chat2, 3, "hi", None)["text"] == "hi"
print("contacts OK")
