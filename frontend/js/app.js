/* Точка входа клиента Aqua: связывает API, WebSocket, состояние и UI-модули. */
import { $ } from './dom.js';
import { debounce } from './dom.js';
import { api, mediaUrl, setToken, getToken, setUnauthorizedHandler } from './api.js';
import { AquaSocket } from './socket.js';
import { storage } from './storage.js';
import { haptic, initTapHaptics } from './haptics.js';
import { initEdgeSwipeBack, initViewportFix } from './touch.js';
import { TOKEN_KEY, PAGE_SIZE, TYPING_EXPIRE_MS, REACTIONS } from './config.js';
import {
  state, activeChat, peerOf, setChats, upsertChat, sortChats, setPresence, resetState, pendingToMessage,
} from './state.js';
import { toast } from './ui/toast.js';
import { initModals, openModal, closeModal } from './ui/modal.js';
import { initAuthView } from './ui/auth-view.js';
import { initChatList } from './ui/chat-list.js';
import {
  initChatView, setEmpty, renderHeader, renderStatus, renderMessages, appendMessage,
  resolvePending, markFailed, prependMessages, setTyping, showLoader, scrollToBottom, setReactions,
  updateMessage, refreshMessages,
} from './ui/chat-view.js';
import { initComposer } from './ui/composer.js';
import { initPicker } from './ui/picker.js';
import { avatar } from './ui/avatar.js';
import { initProfile } from './ui/profile.js';
import { initSettings } from './ui/settings.js';
import { initPeerProfile } from './ui/peer-profile.js';
import { createAvatarViewer, initPullDown } from './ui/avatar-viewer.js';
import { initContacts } from './ui/contacts.js';
import { applyPrefs, applyCachedPrefs } from './theme.js';
import { copyText } from './ui/clipboard.js';
import { initSplash } from './ui/splash.js';
import { initReactions, closeReactionMenu } from './ui/reactions.js';
import { stopVoice } from './ui/voice-player.js';
import { initVoiceRecorder } from './ui/voice-recorder.js';
import { initFileManager } from './ui/file-manager.js';
import { initLightbox } from './ui/lightbox.js';
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

/** Профиль обновлён (нами или пришёл по WS): правим пользователя в чатах и перерисовываем. */
function renderNavAvatar() {
  const u = state.user; if (!u) return;
  $('#nav-avatar').replaceChildren(avatar(u.display_name || u.username, { user: u, small: true }));
}
function applyProfile(u) {
  if (u.id === state.user.id) state.user = { ...state.user, ...u };
  for (const chat of state.chats.values()) {
    chat.members = chat.members.map((m) => (m.id === u.id ? { ...m, ...u } : m));
    if (chat.type === 'direct' && chat.members.some((m) => m.id === u.id) && u.id !== state.user.id) chat.title = u.display_name || u.username;
  }
  profile.render();
  renderNavAvatar();
  renderList();
  const chat = activeChat();
  if (chat) renderHeader(chat);
}
const profile = initProfile({ onChange: applyProfile, onAvatars: () => ownViewer.open(state.user, true) });
const ownViewer = createAvatarViewer({ host: $('#profile-view'), onOwnChange: (u) => applyProfile(u) });
const peerViewer = createAvatarViewer({ host: $('#peer-view'), onOwnChange: () => {} });
const contacts = initContacts({ onOpen: (u) => { closeModal('modal-contacts'); openUser(u.username); } });
// Потянуть вниз в профиле — открыть фото крупно (свой и чужой профиль)
initPullDown($('#modal-settings .modal__body'), () => ownViewer.open(state.user, true), { target: $('#profile-avatar') });

applyCachedPrefs();
const settings = initSettings({
  onUsername: (u) => applyProfile(u),
  onUnblock: () => {},
});
const peerProfile = initPeerProfile({ onChange: () => {}, onAvatars: (u) => peerViewer.open(u, false) });
initPullDown($('#modal-peer .modal__body'), () => peerProfile.openAvatars(), { target: $('#peer-big-avatar') });

const authView = initAuthView({
  onLogin: (u, p) => authenticate(api.login(u, p)),
  onRegister: (u, p) => authenticate(api.register(u, p)),
});

async function enterApp(user) {
  state.user = user;
  applyPrefs(user.prefs);
  renderNavAvatar();
  profile.render();
  setEmpty(true);
  await loadChats();                            // сначала данные, потом экран — без мигания пустого списка
  showScreen('chat');
  socket.connect();
}

function logout(message) {
  socket.close();
  storage.remove(TOKEN_KEY);
  setToken(null);
  resetState();
  connectedOnce = false; outageShown = false;
  searchQuery = ''; foundUsers = null; $('#search').value = '';
  closeModal('modal-settings'); closeModal('modal-prefs'); closeModal('modal-peer'); closeModal('modal-contacts');
  applyPrefs({}, { cache: false });
  stopMedia();
  app.dataset.chatOpen = 'false';
  picker.close();
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
  picker.close();
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
      ...(res.gif && kind === 'video' ? { meta: { gif: true } } : {}),
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

/* ============================== Действия с сообщениями ============================== */
const findMessage = (id) => state.history.get(state.activeChatId)?.items.find((m) => m.id === id);

function messageActions(id) {
  const m = findMessage(id);
  if (!m) return [];
  const mine = m.sender.id === state.user.id;
  const list = [];
  if (m.text) list.push({ icon: 'i-copy', label: 'Копировать', run: async () => toast((await copyText(m.text)) ? 'Скопировано' : 'Не удалось скопировать') });
  if (mine && m.kind !== 'voice' && !m.meta?.sticker) {
    list.push({ icon: 'i-edit', label: 'Изменить', run: () => composer.startEdit({ id: m.id, text: m.text, allowEmpty: m.kind !== 'text' }) });
  }
  list.push({ icon: 'i-trash', label: 'Удалить у меня', danger: true, run: () => removeMessage(id, 'me') });
  if (mine) list.push({ icon: 'i-trash', label: 'Удалить у всех', danger: true, confirm: 'Точно удалить у всех?', run: () => removeMessage(id, 'all') });
  return list;
}

async function removeMessage(id, scope) {
  try {
    const res = await api.deleteMessage(id, scope);
    applyDeleted({ chat_id: res.chat_id, message_id: id, last_message: undefined });   // WS-событие уточнит «последнее сообщение»
  } catch (e) { toast(e.message); haptic.error(); }
}

async function saveEdit(id, text) {
  try { applyEdited(await api.editMessage(id, text)); }
  catch (e) { toast(e.message); haptic.error(); }
}

/** Сообщение изменено (нами или собеседником). Идемпотентно: вызывается и из ответа API, и из WS. */
function applyEdited(m) {
  const h = state.history.get(m.chat_id);
  const i = h?.items.findIndex((x) => x.id === m.id) ?? -1;
  if (i >= 0) h.items[i] = { ...h.items[i], ...m };
  const chat = state.chats.get(m.chat_id);
  if (chat?.last_message?.id === m.id) chat.last_message = { ...chat.last_message, ...m };
  if (m.chat_id === state.activeChatId && chat) updateMessage(h?.items[i] ?? m, chat);
  renderList();
}

/** Сообщение удалено (у всех или только у нас). */
function applyDeleted({ chat_id: chatId, message_id: id, last_message: last }) {
  const h = state.history.get(chatId);
  if (h) h.items = h.items.filter((x) => x.id !== id);
  const chat = state.chats.get(chatId);
  if (chat) {
    if (last !== undefined) chat.last_message = last;
    else if (chat.last_message?.id === id) chat.last_message = h?.items.at(-1) ?? chat.last_message;   // временно, до WS-события
    sortChats();
  }
  if (chatId === state.activeChatId && chat) refreshMessages(chat);
  renderList();
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
socket.on('profile', ({ user }) => applyProfile(user));
socket.on('message_edited', ({ message }) => applyEdited(message));
socket.on('message_deleted', (e) => applyDeleted(e));
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
  onEdit: saveEdit,
  onTyping: (isTyping) => { if (state.activeChatId) socket.send({ type: 'typing', chat_id: state.activeChatId, is_typing: isTyping }); },
  onAttach: () => { if (state.activeChatId) fileManager.open(); },
  onVoice: () => { if (state.activeChatId) voiceRecorder.start(); },
  onEmoji: () => picker.toggle(),
});

/** Панель смайликов/стикеров/GIF: смайлик вставляется в текст, стикер и GIF уходят отдельным сообщением. */
const picker = initPicker({
  onEmoji: (e) => composer.insert(e),
  onGif: async (it) => {
    if (!state.activeChatId) return;
    try {
      if (it.saved) {                                              // из «Сохранённых»: файл уже наш
        const m = it.saved;
        enqueue({ kind: m.kind, mediaId: m.id, mediaInfo: m, meta: { gif: true } });
      } else {                                                     // из поиска: скачиваем на сервер и отправляем
        const media = await api.gifImport(it.url, it.title);
        enqueue({ kind: 'image', mediaId: media.id, mediaInfo: media, meta: { gif: true } });
      }
      picker.close();
    } catch (e) { toast(e.message || 'Не удалось отправить GIF.'); haptic.error(); }
  },
  onSticker: (s) => {
    if (!state.activeChatId) return;
    enqueue({ kind: 'image', mediaId: s.media_id, mediaInfo: { id: s.media_id, url: s.url, name: 'sticker', mime: 'image/webp', size: 0 }, meta: { sticker: s.id, pack: s.pack_id } });
    setTimeout(() => { if (picker.isOpen() && picker.tab() === 'stickers') picker.reloadStickers(); }, 900);   // «недавние» обновятся
  },
  onTabChange: (tab) => composer.setPickerIcon(tab),
  onToggle: (open) => composer.setPickerOpen(open),
});

const fileManager = initFileManager({ onDeviceFile: handleFile, onPickExisting: handleExisting });
initLightbox({ container: $('#messages'), getMessage: findMessage, onDelete: (id, mine) => removeMessage(id, mine ? 'all' : 'me') });
const voiceRecorder = initVoiceRecorder({ onSend: sendVoice, onError: (msg) => { toast(msg); haptic.error(); } });
initReactions({
  container: $('#messages'),
  onPick: pickReaction,
  getQuick: () => state.user.prefs?.quick_reaction || REACTIONS[0],
  getActions: messageActions,
  getMine: (id) => (state.history.get(state.activeChatId)?.items.find((m) => m.id === id)?.reactions ?? [])
    .filter((r) => r.users.includes(state.user.id)).map((r) => r.emoji),
});

$('#btn-back').addEventListener('click', goBack);
$('#profile-settings-btn').addEventListener('click', () => { settings.render(); openModal('modal-prefs'); });
const openPeer = () => { const p = peerOf(activeChat() ?? { type: '' }); if (p) peerProfile.open(p.id); };
$('#chat-peer').addEventListener('click', openPeer);
$('#chat-peer').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPeer(); } });
$('#messages').addEventListener('click', (e) => {
  const a = e.target.closest('.msg__author[data-user-id]');
  if (a && Number(a.dataset.userId) !== state.user.id) peerProfile.open(Number(a.dataset.userId));
});
$('#nav-profile').addEventListener('click', () => { ownViewer.close(); profile.render(); openModal('modal-settings'); });
$('#nav-settings').addEventListener('click', () => { settings.render(); openModal('modal-prefs'); });
$('#nav-contacts').addEventListener('click', () => { contacts.render(); openModal('modal-contacts'); });
$('#nav-chats').addEventListener('click', () => { for (const m of ['modal-settings', 'modal-prefs', 'modal-contacts', 'modal-peer']) closeModal(m); $('#chat-list').scrollTo({ top: 0, behavior: 'smooth' }); });
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
