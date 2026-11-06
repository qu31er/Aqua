/* Панель «Смайлики / GIF» над полем ввода. Выбранная вкладка запоминается и меняет значок кнопки. */
import { $ } from '../dom.js';
import { api, gifProxyUrl } from '../api.js';
import { storage } from '../storage.js';
import { EMOJI } from '../emoji-data.js';

const TAB_KEY = 'aqua.picker.tab';
const RECENT_KEY = 'aqua.emoji.recent';
const RECENT_MAX = 24;

export function initPicker({ onEmoji, onGif, onTabChange, onToggle }) {
  const panel = $('#picker');
  const tabs = [...panel.querySelectorAll('.picker__tab')];
  const panes = { emoji: $('#picker-emoji'), gif: $('#picker-gif') };
  const cats = $('#emoji-cats'), grid = $('#emoji-grid');
  const gifGrid = $('#gif-grid'), gifNote = $('#gif-note'), gifSearch = $('#gif-search');

  let tab = storage.get(TAB_KEY) === 'gif' ? 'gif' : 'emoji';
  let cat = 'recent';
  let gifState = { q: '', next: 0, loading: false, enabled: null, seq: 0 };

  /* ---------- Смайлики ---------- */
  const recent = () => { try { return JSON.parse(storage.get(RECENT_KEY) || '[]'); } catch { return []; } };
  function pushRecent(e) { storage.set(RECENT_KEY, JSON.stringify([e, ...recent().filter((x) => x !== e)].slice(0, RECENT_MAX))); }

  function renderCats() {
    const list = [{ id: 'recent', icon: '🕘', title: 'Недавние' }, ...EMOJI];
    cats.replaceChildren(...list.map((c) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'picker__cat'; b.textContent = c.icon; b.title = c.title;
      b.dataset.cat = c.id; b.setAttribute('aria-pressed', String(c.id === cat));
      return b;
    }));
  }
  function renderEmoji() {
    const items = cat === 'recent' ? recent() : EMOJI.find((c) => c.id === cat).items;
    if (!items.length) { grid.innerHTML = '<p class="picker__note">Здесь появятся недавние смайлики.</p>'; return; }
    grid.replaceChildren(...items.map((e) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'picker__emoji'; b.textContent = e; b.setAttribute('aria-label', e);
      return b;
    }));
  }
  cats.addEventListener('click', (e) => {
    const b = e.target.closest('.picker__cat'); if (!b) return;
    cat = b.dataset.cat; renderCats(); renderEmoji(); grid.scrollTop = 0;
  });
  grid.addEventListener('click', (e) => {
    const b = e.target.closest('.picker__emoji'); if (!b) return;
    pushRecent(b.textContent); onEmoji(b.textContent);
  });

  /* ---------- GIF ---------- */
  function note(text) { gifNote.textContent = text || ''; gifNote.hidden = !text; }

  async function loadGifs(reset) {
    const g = gifState;
    if (g.loading && !reset) return;
    if (reset) { g.next = 0; g.seq++; gifGrid.replaceChildren(); gifGrid.scrollTop = 0; note(''); }
    if (g.next === null) return;
    const seq = g.seq; g.loading = true;
    try {
      if (g.enabled === null) g.enabled = (await api.gifStatus()).enabled;
      if (!g.enabled) { note('GIF-поиск не настроен: администратору нужно задать KLIPY_API_KEY или GIPHY_API_KEY на сервере.'); return; }
      const res = await api.gifSearch(g.q, g.next ?? 0);
      if (seq !== g.seq) return;                       // ответ на устаревший запрос
      for (const it of res.items) gifGrid.append(gifTile(it));
      g.next = res.next;
      if (!gifGrid.children.length) note('Ничего не найдено.');
    } catch (e) {
      if (seq === g.seq) note(e.message || 'Не удалось загрузить GIF.');
    } finally {
      if (seq === g.seq) {
        g.loading = false;
        // Если лента не заполнила панель, прокрутки не будет — догружаем сами
        requestAnimationFrame(() => { if (!panel.hidden && g.next !== null && gifGrid.scrollHeight <= gifGrid.clientHeight + 200) loadGifs(false); });
      }
    }
  }
  function gifTile(it) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'picker__gif'; b.title = it.title || 'GIF';
    b.style.aspectRatio = `${it.w} / ${it.h}`;
    const img = document.createElement('img');
    img.src = gifProxyUrl(it.preview); img.alt = it.title || 'GIF'; img.loading = 'lazy'; img.decoding = 'async';
    b.append(img);
    b.addEventListener('click', () => { b.disabled = true; Promise.resolve(onGif(it)).finally(() => { b.disabled = false; }); });
    return b;
  }
  gifSearch.addEventListener('input', () => {
    clearTimeout(gifSearch._t);
    gifSearch._t = setTimeout(() => { gifState.q = gifSearch.value.trim(); loadGifs(true); }, 350);
  });
  gifGrid.addEventListener('scroll', () => {
    if (gifGrid.scrollTop + gifGrid.clientHeight > gifGrid.scrollHeight - 200) loadGifs(false);
  });

  /* ---------- Вкладки ---------- */
  function setTab(next, { save = true } = {}) {
    tab = next;
    if (save) storage.set(TAB_KEY, tab);
    tabs.forEach((t) => { const on = t.dataset.tab === tab; t.setAttribute('aria-selected', String(on)); t.classList.toggle('is-active', on); });
    panes.emoji.hidden = tab !== 'emoji'; panes.gif.hidden = tab !== 'gif';
    if (tab === 'emoji') { if (cat === 'recent' && !recent().length) cat = 'smileys'; renderCats(); renderEmoji(); }
    else if (!gifGrid.children.length) loadGifs(true);
    onTabChange(tab);
  }
  tabs.forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));

  const open = () => { panel.hidden = false; setTab(tab, { save: false }); onToggle(true); };
  const close = () => { panel.hidden = true; onToggle(false); };
  $('#picker-close').addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) close(); });

  onTabChange(tab);                                    // значок кнопки сразу соответствует сохранённому выбору
  return { toggle: () => (panel.hidden ? open() : close()), close, isOpen: () => !panel.hidden, tab: () => tab };
}
