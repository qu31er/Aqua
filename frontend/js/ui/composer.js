/* Поле ввода: автовысота, Enter / Shift+Enter, индикатор набора, кнопка «отправить/голос». */
import { $ } from '../dom.js';
import { haptic } from '../haptics.js';
import { TYPING_THROTTLE_MS, TYPING_IDLE_MS, ENTER_NEWLINE_ON_TOUCH } from '../config.js';

const isTouch = () => window.matchMedia('(pointer: coarse)').matches;

/**
 * @param {{onSend:(text:string)=>void, onTyping:(isTyping:boolean)=>void, onAttach:()=>void, onVoice:()=>void, onEmoji:()=>void}} h
 */
export function initComposer({ onSend, onEdit, onTyping, onAttach, onVoice, onEmoji }) {
  const form = $('#composer');
  const input = $('#message-input');
  const sendBtn = $('#btn-send');

  let typingSentAt = 0;
  let idleTimer = null;
  let typingActive = false;
  let editing = null;                                   // {id, original, allowEmpty} — режим редактирования
  const bar = $('#edit-bar');

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 128)}px`;   // 8rem — как max-height в CSS
    form.dataset.hasText = String(Boolean(editing) || input.value.trim().length > 0);
  }

  function stopTyping() {
    clearTimeout(idleTimer);
    if (typingActive) { typingActive = false; onTyping(false); }
  }

  input.addEventListener('input', () => {
    autosize();
    if (!input.value.trim()) { stopTyping(); return; }
    const now = Date.now();
    // Шлём «печатает» не чаще раза в TYPING_THROTTLE_MS, а «перестал» — после паузы
    if (!typingActive || now - typingSentAt > TYPING_THROTTLE_MS) {
      typingActive = true; typingSentAt = now; onTyping(true);
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(stopTyping, TYPING_IDLE_MS);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;           // Shift+Enter — перенос строки (по умолчанию)
    if (e.isComposing || e.keyCode === 229) return;        // IME (ввод иероглифов/подсказки) — не перехватываем
    if (ENTER_NEWLINE_ON_TOUCH && isTouch()) return;       // на телефоне Enter = новая строка
    e.preventDefault();
    form.requestSubmit();
  });

  // Не даём кнопке «отправить» забрать фокус — иначе на телефоне закрывается клавиатура.
  sendBtn.addEventListener('pointerdown', (e) => e.preventDefault());

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (editing) {
      const { id, original, allowEmpty } = editing;
      if (!text && !allowEmpty) return;                 // у текстового сообщения подпись не может стать пустой
      endEdit();
      if (text !== original) onEdit(id, text);
      return;
    }
    if (!text) return;
    stopTyping();
    onSend(text);
    haptic.send();
    sendBtn.classList.remove('is-animating'); void sendBtn.offsetWidth; sendBtn.classList.add('is-animating');
    setTimeout(() => sendBtn.classList.remove('is-animating'), 600);
    input.value = '';
    autosize();
    input.focus();
  });

  function endEdit() {
    editing = null;
    bar.hidden = true;
    input.value = '';
    autosize();
  }
  $('#edit-cancel').addEventListener('click', endEdit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && editing) endEdit(); });

  $('#btn-attach').addEventListener('click', onAttach);
  $('#btn-voice').addEventListener('click', onVoice);
  $('#btn-emoji').addEventListener('click', onEmoji);

  return {
    focus: () => { if (!isTouch()) input.focus(); },   // на телефоне не открываем клавиатуру сама по себе
    /** Режим редактирования: текст сообщения попадает в поле, отправка сохраняет изменение. */
    startEdit({ id, text, allowEmpty }) {
      editing = { id, original: text || '', allowEmpty: Boolean(allowEmpty) };
      $('#edit-bar-text').textContent = text || 'Подпись';
      bar.hidden = false;
      input.value = text || '';
      autosize();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
    reset() { editing = null; bar.hidden = true; input.value = ''; autosize(); stopTyping(); },
    stopTyping,
  };
}
