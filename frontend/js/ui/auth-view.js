/* Экран входа и регистрации по почте: почта → код из письма → (для новой почты) имя пользователя. */
import { $ } from '../dom.js';
import { usernameError } from '../validators.js';
import { haptic } from '../haptics.js';

const RESEND_SEC = 60;

function showFormError(node, message) {
  node.textContent = message || '';
  node.hidden = !message;
}
function setFieldError(input, message) {
  input.closest('.field')?.classList.toggle('field--error', Boolean(message));
  const out = $('#' + input.id + '-error');
  if (out) out.textContent = message || '';
}
function shake(node) {
  node.classList.remove('is-shaking');
  void node.offsetWidth;
  node.classList.add('is-shaking');
}
function setBusy(form, busy) {
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = busy;
  btn.dataset.label ??= btn.textContent;
  btn.textContent = busy ? 'Подождите…' : btn.dataset.label;
}
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

/**
 * handlers:
 *  onRequest(email) — отправить код (бросает ApiError при ошибке);
 *  onVerify(email, code) — проверить код; возвращает ticket для нового адреса или null, если вход уже выполнен;
 *  onRegister(ticket, username) — создать аккаунт.
 */
export function initAuthView({ onRequest, onVerify, onRegister }) {
  const emailForm = $('#form-email'), codeForm = $('#form-code'), nameForm = $('#form-name');
  const emailInput = $('#auth-email'), codeInput = $('#auth-code'), nameInput = $('#auth-username');
  const resendBtn = $('#code-resend');
  let email = '', ticket = '', timer = null;

  function show(form) {
    for (const f of [emailForm, codeForm, nameForm]) f.hidden = f !== form;
    (form === emailForm ? emailInput : form === codeForm ? codeInput : nameInput).focus();
  }
  function startCooldown(sec = RESEND_SEC) {
    clearInterval(timer);
    let left = sec;
    resendBtn.disabled = true;
    const tick = () => {
      resendBtn.textContent = left > 0 ? `Отправить снова через ${left} с` : 'Отправить снова';
      if (left <= 0) { clearInterval(timer); resendBtn.disabled = false; }
      left -= 1;
    };
    tick(); timer = setInterval(tick, 1000);
  }

  emailForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#email-error'); showFormError(err, '');
    const value = emailInput.value.trim().toLowerCase();
    if (!EMAIL_RE.test(value)) {
      showFormError(err, 'Введите корректный адрес почты.'); shake(emailForm); haptic.error(); return;
    }
    setBusy(emailForm, true);
    try {
      await onRequest(value);
      email = value;
      $('#code-sent').textContent = `Код отправлен на ${email}. Он действует 10 минут.`;
      codeInput.value = '';
      show(codeForm); startCooldown();
    } catch (e2) {
      showFormError(err, e2.message); shake(emailForm); haptic.error();
    } finally { setBusy(emailForm, false); }
  });

  codeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#code-error'); showFormError(err, '');
    const code = codeInput.value.trim();
    if (!/^\d{6}$/.test(code)) {
      showFormError(err, 'Код — 6 цифр из письма.'); shake(codeForm); haptic.error(); return;
    }
    setBusy(codeForm, true);
    try {
      const t = await onVerify(email, code);
      haptic.success();
      if (t) { ticket = t; nameInput.value = ''; show(nameForm); }
    } catch (e2) {
      showFormError(err, e2.message); shake(codeForm); haptic.error();
    } finally { setBusy(codeForm, false); }
  });

  resendBtn.addEventListener('click', async () => {
    const err = $('#code-error'); showFormError(err, '');
    try {
      await onRequest(email);
      startCooldown();
    } catch (e2) { showFormError(err, e2.message); }
  });

  $('#code-back').addEventListener('click', () => { clearInterval(timer); show(emailForm); });

  nameInput.addEventListener('input', () => setFieldError(nameInput, nameInput.value ? usernameError(nameInput.value.trim()) : ''));
  nameForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#name-error'); showFormError(err, '');
    const username = nameInput.value.trim();
    const uErr = usernameError(username);
    setFieldError(nameInput, uErr);
    if (uErr) { shake(nameForm); haptic.error(); return; }
    setBusy(nameForm, true);
    try {
      await onRegister(ticket, username);
      haptic.success();
    } catch (e2) {
      const f = e2.fields || {};
      if (f.username_errors?.length) setFieldError(nameInput, f.username_errors[0]);
      else showFormError(err, e2.message);
      shake(nameForm); haptic.error();
    } finally { setBusy(nameForm, false); }
  });

  return {
    reset() {
      clearInterval(timer);
      emailForm.reset(); codeForm.reset(); nameForm.reset();
      showFormError($('#email-error'), ''); showFormError($('#code-error'), ''); showFormError($('#name-error'), '');
      setFieldError(nameInput, '');
      email = ''; ticket = '';
      show(emailForm);
    },
  };
}
