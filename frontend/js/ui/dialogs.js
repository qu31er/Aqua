/* Маленькое окошко с полем ввода вместо window.prompt (в приложении-обёртке prompt работает плохо). */
import { el } from '../dom.js';

/** @returns {Promise<string|null>} введённый текст или null при отмене */
export function askText({ title, placeholder = '', value = '', ok = 'Готово', max = 40 }) {
  return new Promise((resolve) => {
    const input = el('input', { class: 'dialog__input', type: 'text', maxlength: String(max), placeholder, value, 'aria-label': title });
    const close = (v) => { box.remove(); resolve(v); };
    const submit = () => { const t = input.value.trim(); if (t) close(t); else input.focus(); };
    const box = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      el('div', { class: 'dialog__backdrop', onclick: () => close(null) }),
      el('form', { class: 'dialog__card', onsubmit: (e) => { e.preventDefault(); submit(); } },
        el('h3', { class: 'dialog__title', text: title }), input,
        el('div', { class: 'dialog__actions' },
          el('button', { class: 'btn btn--ghost', type: 'button', text: 'Отмена', onclick: () => close(null) }),
          el('button', { class: 'btn btn--primary', type: 'submit', text: ok }))));
    box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } });
    document.body.append(box);
    input.focus(); input.select();
  });
}
