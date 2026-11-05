/* Эмодзи-реакции: контекстное меню (ПКМ / двойной клик / долгое нажатие) и клик по «чипам».
   На телефоне меню — «шторка» снизу (стили в components.css), на десктопе — всплывает над сообщением. */
import { el } from '../dom.js';
import { REACTIONS } from '../config.js';
import { haptic } from '../haptics.js';
import { onLongPress } from '../touch.js';

const isMobile = () => window.matchMedia('(max-width: 47.99rem)').matches;
const isRealId = (id) => /^\d+$/.test(id || '');        // у «отправляемых» сообщений id временный
let menu = null;
let outsideHandler = null;

export function closeReactionMenu() {
  menu?.remove();
  menu = null;
  if (outsideHandler) {
    document.removeEventListener('pointerdown', outsideHandler, true);
    outsideHandler = null;
  }
}

/**
 * @param {{container:HTMLElement, onPick:(messageId:number, emoji:string)=>void,
 *          getMine:(messageId:number)=>string[]}} cfg
 *   getMine — какие эмодзи пользователь уже поставил (для подсветки в меню)
 */
export function initReactions({ container, onPick, getMine }) {
  function open(bubble) {
    const msg = bubble.closest('.msg');
    if (!msg || !isRealId(msg.dataset.id) || msg.classList.contains('is-pending')) return;
    const id = Number(msg.dataset.id);
    closeReactionMenu();

    const mine = new Set(getMine(id));
    menu = el('div', { class: 'menu', role: 'menu', 'aria-label': 'Реакции' },
      REACTIONS.map((emoji) => el('button', {
        class: `menu__item${mine.has(emoji) ? ' is-active' : ''}`, type: 'button', role: 'menuitem',
        'aria-label': emoji, text: emoji,
        onclick: () => { closeReactionMenu(); haptic.tap(); onPick(id, emoji); },
      })));
    document.body.append(menu);

    if (!isMobile()) {
      // Над сообщением; если не помещается сверху — под ним. Не выходим за края окна.
      const r = bubble.getBoundingClientRect();
      const mw = menu.offsetWidth, mh = menu.offsetHeight;
      const top = r.top - mh - 8 >= 8 ? r.top - mh - 8 : Math.min(r.bottom + 8, window.innerHeight - mh - 8);
      const left = Math.max(8, Math.min(msg.classList.contains('msg--out') ? r.right - mw : r.left, window.innerWidth - mw - 8));
      Object.assign(menu.style, { top: `${top}px`, left: `${left}px` });
    }

    // Закрытие: касание/клик вне меню, Esc, прокрутка
    outsideHandler = (e) => { if (!menu?.contains(e.target)) closeReactionMenu(); };
    setTimeout(() => document.addEventListener('pointerdown', outsideHandler, true), 0);
  }

  container.addEventListener('contextmenu', (e) => {
    const bubble = e.target.closest('.msg__bubble');
    if (bubble) { e.preventDefault(); open(bubble); }
  });
  container.addEventListener('dblclick', (e) => {
    const bubble = e.target.closest('.msg__bubble');
    if (bubble && !e.target.closest('.vp, a, audio, video')) {
      window.getSelection()?.removeAllRanges();      // двойной клик по умолчанию выделяет слово — убираем
      open(bubble);
    }
  });
  // Телефон: долгое нажатие. Системное меню iOS отключено через -webkit-touch-callout: none.
  onLongPress(container, '.msg__bubble', (bubble) => { haptic.tap(); open(bubble); });

  // Клик по уже поставленной реакции — поставить/снять свою
  container.addEventListener('click', (e) => {
    const chip = e.target.closest('.reaction');
    const msg = chip?.closest('.msg');
    if (chip && msg && isRealId(msg.dataset.id)) onPick(Number(msg.dataset.id), chip.dataset.emoji);
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeReactionMenu(); });
  container.addEventListener('scroll', closeReactionMenu, { passive: true });
  window.addEventListener('resize', closeReactionMenu);
}
