# Вход по почте без FastAPI: код одноразовый, после ошибок сгорает, билет для нового адреса, старый вход отключён.
import sys, types, os, tempfile, pathlib, time
os.environ["AQUA_DATA_DIR"] = tempfile.mkdtemp()
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
class HTTPException(Exception):
    def __init__(self, status, detail=None, headers=None): self.status, self.detail = status, detail
fa = types.ModuleType("fastapi")
class _R:
    def __init__(self, *a, **k): pass
    def __getattr__(self, name): return lambda *a, **k: (lambda f: f)
fa.APIRouter = _R; fa.HTTPException = HTTPException; fa.Depends = lambda f=None: f; fa.WebSocket = object
fa.UploadFile = object; fa.Query = lambda *a, **k: None; fa.Response = object; fa.Header = lambda *a, **k: None
fa.WebSocketDisconnect = Exception; fa.status = types.SimpleNamespace(); fa.Request = object
sys.modules["fastapi"] = fa
fr = types.ModuleType("fastapi.responses"); fr.FileResponse = object; sys.modules["fastapi.responses"] = fr
_b = types.ModuleType("bcrypt"); _b.hashpw = lambda p, s: b"x"; _b.gensalt = lambda *a, **k: b"s"; _b.checkpw = lambda *a: False
sys.modules["bcrypt"] = _b
pyd = types.ModuleType("pydantic")
class BaseModel:
    def __init__(self, **kw):
        for k, v in kw.items(): setattr(self, k, v)
pyd.BaseModel = BaseModel; pyd.Field = lambda *a, **k: None; sys.modules["pydantic"] = pyd
from app import database, config, email_auth, mail
from app.routers import auth
database.init_db()
c = database._open(config.DB_PATH)
sent = {}
config.EMAIL_DEV = True
mail.send_login_code = lambda to, code: sent.__setitem__(to, code)
email_auth.send_login_code = mail.send_login_code
email_auth.mail_ready = lambda: True
def expect(status, fn):
    try: fn(); raise SystemExit(f"expected {status}")
    except HTTPException as e: assert e.status == status, (e.status, e.detail)
email_auth.request_code(email_auth.EmailRequest(email="Ann@Example.com"), c)
code = sent["ann@example.com"]
expect(429, lambda: email_auth.request_code(email_auth.EmailRequest(email="ann@example.com"), c))   # cooldown
expect(400, lambda: email_auth.verify_code(email_auth.EmailVerify(email="ann@example.com", code="000000" if code != "000000" else "111111"), c))
r = email_auth.verify_code(email_auth.EmailVerify(email="ann@example.com", code=code), c)
assert r["status"] == "need_username" and r["ticket"]
expect(400, lambda: email_auth.verify_code(email_auth.EmailVerify(email="ann@example.com", code=code), c))  # код одноразовый
u = email_auth.register_with_email(email_auth.EmailRegister(ticket=r["ticket"], username="ann_1"), c)
assert u["status"] == "ok" and u["user"]["username"] == "ann_1"
# повторная регистрация с тем же билетом не сработает: почта уже привязана
expect(409, lambda: email_auth.register_with_email(email_auth.EmailRegister(ticket=r["ticket"], username="ann_2"), c))
# следующий вход — по коду, сразу в аккаунт
c.execute("UPDATE email_codes SET created_at = created_at - 120"); c.commit()
email_auth.request_code(email_auth.EmailRequest(email="ann@example.com"), c)
r2 = email_auth.verify_code(email_auth.EmailVerify(email="ann@example.com", code=sent["ann@example.com"]), c)
assert r2["status"] == "ok" and r2["user"]["username"] == "ann_1"
# брутфорс: 5 неверных — код сгорает
c.execute("UPDATE email_codes SET created_at = created_at - 120"); c.commit()
email_auth.request_code(email_auth.EmailRequest(email="bob@example.com"), c)
wrong = "000000" if sent["bob@example.com"] != "000000" else "111111"
for _ in range(5):
    expect(400, lambda: email_auth.verify_code(email_auth.EmailVerify(email="bob@example.com", code=wrong), c))
expect(429, lambda: email_auth.verify_code(email_auth.EmailVerify(email="bob@example.com", code=sent["bob@example.com"]), c))
# старый вход по паролю отключён
assert not hasattr(auth, "login") and not hasattr(auth, "register")
print("email auth OK")
