/* Тонкая обёртка над fetch для REST API Aqua. */
import { API_BASE } from './config.js';

export class ApiError extends Error {
  /** @param {number} status  @param {object} fields — {username_errors, password_errors} при 422 */
  constructor(status, message, fields = {}) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

let token = null;
let onUnauthorized = () => {};
export const setToken = (t) => { token = t; };
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };
export const getToken = () => token;

/** Приводит разные формы detail (строка / объект Aqua / массив FastAPI) к понятному тексту. */
function normalizeError(status, detail) {
  if (typeof detail === 'string') return new ApiError(status, detail);
  if (Array.isArray(detail)) return new ApiError(status, 'Проверьте введённые данные.');
  if (detail && typeof detail === 'object') {
    return new ApiError(status, detail.message || 'Ошибка запроса.', {
      username_errors: detail.username_errors || [],
      password_errors: detail.password_errors || [],
    });
  }
  return new ApiError(status, 'Неизвестная ошибка сервера.');
}

async function request(path, { method = 'GET', json, form, auth = true } = {}) {
  const headers = {};
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;   // FormData: Content-Type с boundary браузер выставит сам

  let res;
  try {
    res = await fetch(API_BASE + path, { method, headers, body });
  } catch {
    throw new ApiError(0, 'Нет соединения с сервером.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* пустое тело */ }

  if (!res.ok) {
    // 401 на обычных запросах = токен истёк. На /auth/login 401 — просто неверный пароль.
    if (res.status === 401 && auth && token) onUnauthorized();
    throw normalizeError(res.status, data?.detail);
  }
  return data;
}

export const api = {
  register: (username, password) => request('/auth/register', { method: 'POST', json: { username, password }, auth: false }),
  login:    (username, password) => request('/auth/login',    { method: 'POST', json: { username, password }, auth: false }),
  me:       () => request('/auth/me'),
  searchUsers: (q) => request(`/users/search?q=${encodeURIComponent(q)}`),
  listChats: () => request('/chats'),
  createDirectChat: (username) => request('/chats', { method: 'POST', json: { type: 'direct', username } }),
  getMessages: (chatId, beforeId, limit) =>
    request(`/chats/${chatId}/messages?limit=${limit}${beforeId ? `&before_id=${beforeId}` : ''}`),
  sendMessage: (chatId, text, mediaId = null, meta = null, coverId = null) =>
    request(`/chats/${chatId}/messages`, { method: 'POST', json: { text, media_id: mediaId, meta, cover_id: coverId } }),
  toggleReaction: (messageId, emoji) =>
    request(`/messages/${messageId}/reactions`, { method: 'PUT', json: { emoji } }),
  uploadMedia: (file) => { const form = new FormData(); form.append('file', file); return request('/media', { method: 'POST', form }); },
  editMessage: (id, text) => request(`/messages/${id}`, { method: 'PATCH', json: { text } }),
  deleteMessage: (id, scope) => request(`/messages/${id}?scope=${scope}`, { method: 'DELETE' }),
  gifStatus: () => request('/gifs/status'),
  gifSearch: (q, pos) => request(`/gifs/search?q=${encodeURIComponent(q)}&pos=${pos}`),
  gifImport: (url, title) => request('/gifs/import', { method: 'POST', json: { url, title } }),
  mediaSummary: () => request('/media/summary'),
  recentMedia: (kind) => request(`/media${kind ? `?kind=${kind}` : ''}`),
};

/** URL файла с токеном (теги <img>/<video>/<audio> не умеют слать заголовки). */
export const mediaUrl = (url) => `${url}?token=${encodeURIComponent(token || '')}`;

/** Превью GIF идёт через наш сервер (CSP не пускает на чужие CDN). */
export const gifProxyUrl = (u) => `${API_BASE}/gifs/proxy?u=${encodeURIComponent(u)}&token=${encodeURIComponent(token || '')}`;
