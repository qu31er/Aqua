/* Точка входа клиента Aqua: связывает API, WebSocket, состояние и UI-модули. */
import { $ } from './dom.js';
import { debounce } from './dom.js';
import { api, mediaUrl, setToken, getToken, setUnauthorizedHandler } from './api.js';
import { AquaSocket } from './socket.js';
import { storage } from './storage.js';
import { haptic, initTapHaptics } from './haptics.js';
import { initEdgeSwipeBack, initViewportFix } from './touch.js';
import { TOKEN_KEY, PAGE_SIZE, TYPING_EXPIRE_MS } from './config.js';
import {
  state, activeChat, setChats, upsertChat, sortChats, setPresence, resetState, pendingToMessage,
} from './state.js';
import { toast } from './ui/toast.js';
import { initModals, openModal, closeModal } from './ui/modal.js';
import { initAuthView } from './ui/auth-view.js';
import { initChatList } from './ui/chat-list.js';
import {
  initChatView, setEmpty, renderHeader, renderStatus, renderMessages, appendMessage,
  resolvePending, markFailed, prependMessages, setTyping, showLoader, scrollToBottom, setReactions,
} from './ui/chat-view.js';
import { initComposer } from './ui/composer.js';
import { initSplash } from './ui/splash.js';
import { initReactions, closeReactionMenu } from './ui/reactions.js';
import { stopVoice } from './ui/voice-player.js';
import { initVoiceRecorder } from './ui/voice-recorder.js';
import { initFileManager } from './ui/file-manager.js';
import { openEditor } from './editor/editor-modal.js';

const app = $('#app');
const socket = new AquaSocket(getToken);
const isMobileLayout = () => window.matchMedia('(max-width: 47.99rem)').matches;

let searchQuery = '';
let foundUsers = null;
let searchSeq = 0;
let connectedOnce = false;
let outageShown = false;

/* ============================== Экраны ============================== */
const showScreen = (name) => { app.dataset.screen = name; };
const renderList = () => chatList.render(searchQuery, foundUsers);

/* ============================== Авторизация ============================== */
async function authenticate(request) {
  const { token, user } = await request;
  storage.set(TOKEN_KEY, token);
  setToken(token);
  await enterApp(user);
}

const authView = initAuthView({
  onLogin: (u, p) => authenticate(api.login(u, p)),
  onRegister: (u, p) => authenticate(api.register(u, p)),
});

async function enterApp(user) {
  state.user = user;
  $('#settings-username').textContent = user.username;
  setEmpty(true);
  showScreen('chat');
  await loadChats();
  socket.connect();
}

function logout(message) {
  socket.close();
  storage.remove(TOKEN_KEY);
  setToken(null);
  resetState();
  connectedOnce = false; outageShown = false;
  searchQuery = ''; foundUsers = null; $('#search').value = '';
  closeModal('modal-settings');
  stopMedia();
  app.dataset.chatOpen = 'false';
  composer.reset();
  authView.reset();
  showScreen('auth');
  if (message) toast(message);
}

setUnauthorizedHandler(() => logout('Сессия истекла. Войдите снова.'));
socket.on('unauthorized', () => logout('Сессия истекла. Войдите снова.'));

/** Останавливает воспроизведение, запись голоса и закрывает меню реакций (при смене/закрытии чата). */
function stopMedia() {
  stopVoice();
  voiceRecorder.cancel();
  closeReactionMenu();
}

/* ============================== Чаты ============================== */
async function loadChats() {
  try {
    setChats(await api.listChats());
    renderList();
  } catch (e) { toast(e.message); }
}

async function openChat(id, { push = true } = {}) {
  const chat = state.chats.get(id);
  if (!chat) return;
  const wasOpen = app.dataset.chatOpen === 'true';
  stopMedia();
  state.activeChatId = id;
  state.unread.delete(id);
  app.dataset.chatOpen = 'true';
  // На телефоне диалог — «следующий экран»: добавляем запись в историю, чтобы системная кнопка «Назад» вела в список
  if (push && !wasOpen && isMobileLayout()) history.pushState({ chat: id }, '');
  setEmpty(false);
  renderHeader(chat);
  renderList();
  setTyping(Boolean(state.typing.get(id)?.size));

  if (state.history.has(id)) {
    renderMessages(chat);
  } else {
    state.history.set(id, { items: [], hasMore: true, loading: false });
    renderMessages(chat);
    await loadHistory(id, true);
  }
  composer.focus();
}

function closeChat() {
  stopMedia();
  state.activeChatId = null;
  app.dataset.chatOpen = 'false';
  setEmpty(true);
  composer.reset();
  renderList();
}

function goBack() {
  if (history.state?.chat) history.back();   // popstate вызовет closeChat
  else closeChat();
}
window.addEventListener('popstate', () => { if (state.activeChatId && isMobileLayout()) closeChat(); });

async function loadHistory(chatId, initial = false) {
  const h = state.history.get(chatId);
  if (!h || h.loading || (!initial && !h.hasMore)) return;
  h.loading = true;
  if (!initial) showLoader(true);
  try {
    const page = await api.getMessages(chatId, initial ? undefined : h.items[0]?.id, PAGE_SIZE);
    const chat = state.chats.get(chatId);
    const firstIso = h.items[0]?.created_at;
    h.hasMore = page.length === PAGE_SIZE;
    const known = new Set(h.items.map((m) => m.id));
    const fresh = page.filter((m) => !known.has(m.id));
    h.items = [...fresh, ...h.items];
    if (state.activeChatId === chatId) {
      if (initial) renderMessages(chat);
      else prependMessages(fresh, chat, firstIso);
    }
  } catch (e) {
    toast(e.message);
  } finally {
    h.loading = false;
    if (!initial) showLoader(false);
  }
}

/** После переподключения подтягиваем пропущенное. */
async function resync() {
  await loadChats();
  const id = state.activeChatId;
  const h = id && state.history.get(id);
  if (!h) return;
  try {
    const page = await api.getMessages(id, undefined, PAGE_SIZE);
    const known = new Set(h.items.map((m) => m.id));
    const missed = page.filter((m) => !known.has(m.id));
    if (missed.length) {
      h.items.push(...missed);
      if (state.activeChatId === id) renderMessages(state.chats.get(id));
    }
  } catch { /* повторим при следующем подключении */ }
}

/* ============================== Отправка ============================== */
const newClientId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function removePending(chatId, clientId) {
  const list = state.pending.get(chatId) ?? [];
  const p = list.find((x) => x.clientId === clientId);
  if (p?.localUrl) URL.revokeObjectURL(p.localUrl);
  if (p?.coverLocalUrl) URL.revokeObjectURL(p.coverLocalUrl);
  state.pending.set(chatId, list.filter((x) => x.clientId !== clientId));
}

/** Кладёт сообщение в очередь «отправляется»: показываем сразу, отправляем в фоне. */
function enqueue(draft) {
  const chat = activeChat();
  if (!chat) return;
  const list = state.pending.get(chat.id) ?? [];
  state.pending.set(chat.id, list);
  const p = { clientId: newClientId(), created_at: new Date().toISOString(), failed: false, kind: 'text', text: null, ...draft };
  list.push(p);
  appendMessage(pendingToMessage(p), chat, { forceScroll: true });
  dispatch(chat, p);
}

/** Отправка: голосовое сначала загружаем как медиа, затем шлём сообщение (WebSocket → запасной REST). */
async function dispatch(chat, p) {
  try {
    // Любое вложение сначала загружаем как медиа (повторная отправка не грузит заново)
    if (p.file && !p.mediaId) p.mediaId = (await api.uploadMedia(p.file)).id;
    if (p.coverFile && !p.coverId) p.coverId = (await api.uploadMedia(p.coverFile)).id;
    const payload = { chat_id: chat.id, text: p.text, media_id: p.mediaId ?? null, meta: p.meta ?? null, cover_id: p.coverId ?? null };

    // Если за 15 с подтверждения нет — помечаем неотправленным (тап — повторить)
    setTimeout(() => {
      const still = (state.pending.get(chat.id) ?? []).find((x) => x.clientId === p.clientId);
      if (still && !still.failed) { still.failed = true; markFailed(p.clientId, chat); }
    }, 15000);

    if (socket.send({ type: 'message', ...payload, client_id: p.clientId })) return;
    const message = await api.sendMessage(chat.id, p.text, payload.media_id, payload.meta, payload.cover_id);
    onMessage({ message, client_id: p.clientId });
  } catch (e) {
    p.failed = true;
    markFailed(p.clientId, chat);
    toast(e.message);
    haptic.error();
  }
}

function retrySend(clientId) {
  const chat = activeChat();
  const p = chat && (state.pending.get(chat.id) ?? []).find((x) => x.clientId === clientId);
  if (!p) return;
  p.failed = false;
  renderMessages(chat);
  dispatch(chat, p);
}

const sendText = (text) => enqueue({ text });

function sendVoice({ blob, mime, duration, wave }) {
  const ext = mime.includes('wav') ? 'wav' : mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
  const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: mime });
  enqueue({ kind: 'voice', file, meta: { duration: Math.round(duration * 100) / 100, wave }, localUrl: URL.createObjectURL(blob) });
}

/** Файл с устройства: фото/видео → редактор, остальное отправляем сразу. */
async function handleFile(file) {
  if (!state.activeChatId) return;
  if (file.type.startsWith('image/') || file.type.startsWith('video/')) {
    const res = await openEditor(file);
    if (!res) return;
    const kind = res.file.type.startsWith('video/') ? 'video' : 'image';
    enqueue({
      kind, file: res.file, text: res.caption || null, localUrl: URL.createObjectURL(res.file),
      ...(res.cover ? { coverFile: res.cover, coverLocalUrl: URL.createObjectURL(res.cover) } : {}),
    });
    return;
  }
  const kind = file.type.startsWith('audio/') ? 'voice' : 'file';
  if (kind === 'voice') { toast('Для голосовых используйте микрофон.'); return; }
  enqueue({ kind: 'file', file, localUrl: URL.createObjectURL(file) });
}

/** Уже загруженный файл из менеджера: фото/видео скачиваем в редактор, прочее шлём как есть. */
async function handleExisting(item) {
  if (item.kind === 'image' || item.kind === 'video') {
    try {
      const blob = await (await fetch(mediaUrl(item.url))).blob();
      await handleFile(new File([blob], item.name, { type: item.mime }));
    } catch { toast('Не удалось открыть файл.'); }
    return;
  }
  enqueue({ kind: item.kind, mediaId: item.id, mediaInfo: item, meta: null });
}

/* ============================== Реакции ============================== */
function applyReactions(chatId, messageId, reactions) {
  const m = state.history.get(chatId)?.items.find((x) => x.id === messageId);
  if (m) m.reactions = reactions;
  const last = state.chats.get(chatId)?.last_message;
  if (last?.id === messageId) last.reactions = reactions;
  if (chatId === state.activeChatId) setReactions(messageId, reactions);
}

async function pickReaction(messageId, emoji) {
  const chatId = state.activeChatId;
  try {
    const res = await api.toggleReaction(messageId, emoji);
    applyReactions(chatId, messageId, res.reactions);
  } catch (e) { toast(e.message); }
}

/* ============================== События сервера ============================== */
function onMessage({ message: m, client_id: clientId }) {
  const chat = state.chats.get(m.chat_id);
  if (!chat) { loadChats(); return; }          // сообщение из нового, ещё неизвестного чата

  const mine = m.sender.id === state.user.id;
  chat.last_message = m;
  sortChats();
  clearTyper(m.chat_id, m.sender.id, { silent: true });

  const h = state.history.get(m.chat_id);
  const known = Boolean(h?.items.some((x) => x.id === m.id));
  if (h && !known) h.items.push(m);
  if (clientId) removePending(m.chat_id, clientId);

  const active = m.chat_id === state.activeChatId;
  if (active) {
    const replaced = clientId ? resolvePending(clientId, m, chat) : false;
    if (!replaced && !known) appendMessage(m, chat, { forceScroll: mine });
    renderStatus(chat);
    setTyping(Boolean(state.typing.get(m.chat_id)?.size));
  }
  if (!mine) {
    if (!(active && !document.hidden)) state.unread.set(m.chat_id, (state.unread.get(m.chat_id) || 0) + 1);
    haptic.receive();
  }
  renderList();
}

/* --- «печатает…» --- */
function setTyper(chatId, userId, username) {
  let map = state.typing.get(chatId);
  if (!map) { map = new Map(); state.typing.set(chatId, map); }
  clearTimeout(map.get(userId)?.timer);
  // Если обновление не пришло — сами гасим индикатор
  map.set(userId, { username, timer: setTimeout(() => clearTyper(chatId, userId), TYPING_EXPIRE_MS) });
  refreshTyping(chatId);
}

function clearTyper(chatId, userId, { silent = false } = {}) {
  const map = state.typing.get(chatId);
  const t = map?.get(userId);
  if (!t) return;
  clearTimeout(t.timer);
  map.delete(userId);
  if (!silent) refreshTyping(chatId);
}

function refreshTyping(chatId) {
  renderList();
  if (chatId === state.activeChatId) {
    renderStatus(state.chats.get(chatId));
    setTyping(Boolean(state.typing.get(chatId)?.size));
  }
}

socket.on('ready', () => {
  if (outageShown) { outageShown = false; toast('Соединение восстановлено'); }
  if (connectedOnce) resync();
  connectedOnce = true;
});
socket.on('state', (s) => {
  if (s === 'closed' && state.user && connectedOnce && !outageShown) {
    outageShown = true;
    toast('Соединение потеряно. Переподключаемся…', 4000);
  }
});
socket.on('message', onMessage);
socket.on('typing', ({ chat_id, user_id, username, is_typing }) =>
  is_typing ? setTyper(chat_id, user_id, username) : clearTyper(chat_id, user_id));
socket.on('presence', ({ user_id, online, last_seen }) => {
  setPresence(user_id, online, last_seen);
  renderList();
  const chat = activeChat();
  if (chat) renderHeader(chat);
});
socket.on('reaction', ({ chat_id, message_id, reactions }) => applyReactions(chat_id, message_id, reactions));
socket.on('chat_created', ({ chat }) => { upsertChat(chat); renderList(); });
socket.on('error', ({ detail }) => {
  toast(detail || 'Ошибка сервера');
  haptic.error();
  // Сервер не говорит, какое сообщение отклонено, — помечаем самое старое отправляемое
  const chat = activeChat();
  const p = chat && (state.pending.get(chat.id) ?? []).find((x) => !x.failed);
  if (p) { p.failed = true; markFailed(p.clientId, chat); }
});

/* ============================== Поиск ============================== */
const searchUsers = debounce(async (q) => {
  const mySeq = ++searchSeq;
  try {
    const users = await api.searchUsers(q);
    if (mySeq === searchSeq) { foundUsers = users; renderList(); }
  } catch { /* поиск по локальным чатам продолжает работать */ }
}, 250);

$('#search').addEventListener('input', (e) => {
  searchQuery = e.target.value.slice(0, 32);
  if (searchQuery.trim()) searchUsers(searchQuery.trim());
  else { searchSeq += 1; foundUsers = null; }
  renderList();
});

async function openUser(username) {
  try {
    const chat = await api.createDirectChat(username);
    upsertChat(chat);
    searchQuery = ''; foundUsers = null; $('#search').value = '';
    await openChat(chat.id);
  } catch (e) { toast(e.message); }
}

/* ============================== Сборка UI ============================== */
const chatList = initChatList({ onOpenChat: (id) => openChat(id), onOpenUser: openUser });
initChatView({
  loadMore: () => loadHistory(state.activeChatId),
  retry: retrySend,
});
const composer = initComposer({
  onSend: (text) => sendText(text),
  onTyping: (isTyping) => { if (state.activeChatId) socket.send({ type: 'typing', chat_id: state.activeChatId, is_typing: isTyping }); },
  onAttach: () => { if (state.activeChatId) fileManager.open(); },
  onVoice: () => { if (state.activeChatId) voiceRecorder.start(); },
  onEmoji: () => toast('Смайлики появятся на следующем этапе'),
});

const fileManager = initFileManager({ onDeviceFile: handleFile, onPickExisting: handleExisting });
const voiceRecorder = initVoiceRecorder({ onSend: sendVoice, onError: (msg) => { toast(msg); haptic.error(); } });
initReactions({
  container: $('#messages'),
  onPick: pickReaction,
  getMine: (id) => (state.history.get(state.activeChatId)?.items.find((m) => m.id === id)?.reactions ?? [])
    .filter((r) => r.users.includes(state.user.id)).map((r) => r.emoji),
});

$('#btn-back').addEventListener('click', goBack);
$('#btn-menu').addEventListener('click', () => openModal('modal-settings'));
$('#btn-logout').addEventListener('click', () => logout());

initModals();
initTapHaptics();
initEdgeSwipeBack($('#screen-chat'), () => { if (state.activeChatId && isMobileLayout()) goBack(); });
initViewportFix(() => { if (state.activeChatId) scrollToBottom(); });

/* ============================== Запуск ============================== */
initSplash();                                   // заставка идёт параллельно с загрузкой данных

(async function boot() {
  const saved = storage.get(TOKEN_KEY);
  if (saved) {
    setToken(saved);
    try {
      await enterApp(await api.me());
      return;
    } catch { /* токен недействителен или нет сети — показываем вход */ }
  }
  showScreen('auth');
})();

window.__aquaStarted?.();                       // сообщаем стражу (boot-check.js), что модули загрузились
