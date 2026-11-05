# Деплой Aqua на Railway

## 1. Структура репозитория (важно!)
Папки должны остаться как есть. Бэкенд ищет фронтенд по пути `../frontend`, а модули импортируются как пакет `app`:

```
aqua/                    ← корень репозитория
├─ backend/app/...       ← сервер (FastAPI)
├─ frontend/             ← index.html, css/, js/, assets/
├─ requirements.txt      ← Railway ищет его в корне
├─ railway.json, Procfile, .python-version
└─ DEPLOY.md, README.md, docs/, tests/, tools/
```
Если залить файлы «в кучу» без папок, сервер не запустится (не найдёт `app` и `frontend`).

**Как залить с папками:**
- Через git: `git init && git add . && git commit -m "Aqua" && git branch -M main && git remote add origin <URL> && git push -u origin main`.
- Через сайт GitHub: «Add file → Upload files» и перетащите **саму папку** (не её содержимое по одному файлу) — подпапки сохраняются.

## 2. Railway
1. New Project → Deploy from GitHub repo → выберите репозиторий. Сборку и команду запуска Railway возьмёт из `railway.json`.
2. **Volume:** сервис → Settings → Volumes → Add Volume, Mount path `/data`. Без него база и файлы пропадают при каждом деплое.
3. **Variables:** `AQUA_SECRET_KEY` (длинная случайная строка), `AQUA_DATA_DIR=/data`.
4. Settings → Networking → Generate Domain. Откройте выданный адрес (https://…up.railway.app).
5. Реплика должна быть одна: SQLite и список подключений WebSocket живут в одном процессе.

## 3. Проверка
`https://<ваш-домен>/api/health` → `{"status":"ok"}`. Затем регистрация и вход на главной странице.

## 4. Локальный запуск
```
pip install -r requirements.txt
cd backend && uvicorn app.main:app --reload
# открыть http://127.0.0.1:8000  (не файлом index.html!)
```
