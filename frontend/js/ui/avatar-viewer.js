/* Просмотр фото профиля крупным планом: карусель всех аватарок. У своего профиля — меню ⋮ (сделать основным, удалить). */
import { $, el } from '../dom.js';
import { api, mediaUrl } from '../api.js';
import { toast } from './toast.js';

export function initAvatarViewer({ onOwnChange }) {
  const root = $('#avatar-viewer'), track = $('#avv-track'), dots = $('#avv-dots');
  const menu = $('#avv-menu'), more = $('#avv-more');
  let list = [], own = false, restoreFocus = null;

  const index = () => Math.round(track.scrollLeft / Math.max(track.clientWidth, 1));
  const closeMenu = () => { menu.hidden = true; more.setAttribute('aria-expanded', 'false'); };

  function renderDots() {
    dots.replaceChildren(...list.map((_, i) => el('i', { class: i === index() ? 'is-on' : '' })));
    dots.hidden = list.length < 2;
  }
  function renderSlides() {
    track.replaceChildren(...list.map((a) => el('div', { class: 'avv__slide' },
      el('img', { src: mediaUrl(a.url), alt: 'Фото профиля', draggable: 'false' }))));
    renderDots();
  }
  function renderMenu() {
    const cur = list[index()];
    const items = [];
    if (cur && !cur.current) items.push(['Сделать основным', 'avv-act-main', false, makeMain]);
    items.push(['Удалить фото', 'avv-act-delete', true, remove]);
    menu.replaceChildren(...items.map(([t, id, danger, fn]) => el('button', {
      type: 'button', role: 'menuitem', id, class: `peer-menu__item${danger ? ' peer-menu__item--danger' : ''}`, text: t, onclick: () => { closeMenu(); fn(); },
    })));
  }

  async function makeMain() {
    const cur = list[index()];
    try { onOwnChange(await api.updateProfile({ avatar_id: cur.media_id })); list = await api.userAvatars(own.id); renderSlides(); track.scrollLeft = 0; toast('Фото сделано основным'); }
    catch (e) { toast(e.message || 'Не удалось выполнить.'); }
  }
  async function remove() {
    const cur = list[index()];
    try {
      const res = await api.deleteAvatar(cur.media_id);
      onOwnChange(res.profile); list = res.avatars;
      if (!list.length) { close(); toast('Фото удалено'); return; }
      const keep = Math.min(index(), list.length - 1);
      renderSlides(); track.scrollLeft = keep * track.clientWidth; renderDots(); toast('Фото удалено');
    } catch (e) { toast(e.message || 'Не удалось удалить.'); }
  }

  function close() {
    root.hidden = true; closeMenu(); track.replaceChildren();
    restoreFocus?.focus?.();
  }

  track.addEventListener('scroll', () => { renderDots(); closeMenu(); }, { passive: true });
  more.addEventListener('click', (e) => { e.stopPropagation(); renderMenu(); menu.hidden = !menu.hidden; more.setAttribute('aria-expanded', String(!menu.hidden)); });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });
  $('#avv-close').addEventListener('click', close);
  // Клик по фону (не по картинке) закрывает; Esc — тоже; стрелки листают
  track.addEventListener('click', (e) => { if (e.target.closest('.avv__slide') && !e.target.closest('img')) close(); });
  document.addEventListener('keydown', (e) => {
    if (root.hidden) return;
    if (e.key === 'Escape') { e.stopPropagation(); menu.hidden ? close() : closeMenu(); }
    if (e.key === 'ArrowRight') track.scrollBy({ left: track.clientWidth, behavior: 'smooth' });
    if (e.key === 'ArrowLeft') track.scrollBy({ left: -track.clientWidth, behavior: 'smooth' });
  }, true);

  return {
    /** user: {id, display_name, username}; isOwn — свой профиль. Возвращает false, если у пользователя нет фото. */
    async open(user, isOwn) {
      let items;
      try { items = await api.userAvatars(user.id); } catch (e) { toast(e.message || 'Не удалось загрузить фото.'); return false; }
      if (!items.length) return false;
      list = items; own = isOwn ? user : false;
      restoreFocus = document.activeElement;
      $('#avv-who').textContent = user.display_name || user.username;
      $('#avv-menu-wrap').hidden = !isOwn;
      root.hidden = false; closeMenu(); renderSlides();
      track.scrollLeft = 0; $('#avv-close').focus();
      return true;
    },
    close, isOpen: () => !root.hidden,
  };
}

/** Жест «потянуть вниз» на прокручиваемом теле окна: когда контент уже вверху и палец ушёл вниз дальше порога — вызываем onPull. */
export function initPullDown(scroller, onPull, { threshold = 70, target = null } = {}) {
  let y0 = null, pulled = false;
  scroller.addEventListener('touchstart', (e) => { y0 = scroller.scrollTop <= 0 ? e.touches[0].clientY : null; pulled = false; }, { passive: true });
  scroller.addEventListener('touchmove', (e) => {
    if (y0 == null || pulled) return;
    const dy = e.touches[0].clientY - y0;
    if (target) target.style.transform = dy > 0 ? `scale(${1 + Math.min(dy, 140) / 700})` : '';
    if (dy > threshold && scroller.scrollTop <= 0) { pulled = true; if (target) target.style.transform = ''; onPull(); }
  }, { passive: true });
  const reset = () => { y0 = null; if (target) target.style.transform = ''; };
  scroller.addEventListener('touchend', reset); scroller.addEventListener('touchcancel', reset);
}
