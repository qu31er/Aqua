/* Экран входа/регистрации: вкладки, показ пароля, живая проверка правил, отправка форм. */
import { $, $$ } from '../dom.js';
import { checkPassword, isPasswordValid, usernameError } from '../validators.js';
import { haptic } from '../haptics.js';

function setFieldError(input, message) {
  const field = input.closest('.field');
  field?.classList.toggle('field--error', Boolean(message));
  const out = $('#' + input.id + '-error');
  if (out) out.textContent = message || '';
}

function showFormError(node, messages) {
  const list = [messages].flat().filter(Boolean);
  node.textContent = list.join(' ');
  node.hidden = list.length === 0;
}

function shake(node) {
  node.classList.remove('is-shaking');
  void node.offsetWidth;                  // перезапуск CSS-анимации
  node.classList.add('is-shaking');
}

function setBusy(form, busy) {
  const btn = $('button[type="submit"]', form);
  btn.disabled = busy;
  btn.dataset.label ??= btn.textContent;
  btn.textContent = busy ? 'Подождите…' : btn.dataset.label;
}

/** Показывает/скрывает правила пароля: .is-ok — выполнено, .is-bad — не выполнено (когда поле не пустое). */
function renderRules(password) {
  const results = checkPassword(password);
  for (const { id, ok } of results) {
    const li = $(`[data-rule="${id}"]`);
    li.classList.toggle('is-ok', ok);
    li.classList.toggle('is-bad', !ok && password.length > 0);
  }
}

/**
 * @param {{onLogin:(u:string,p:string)=>Promise<void>, onRegister:(u:string,p:string)=>Promise<void>}} handlers
 * Обработчики кидают ApiError — здесь он превращается в сообщения на форме.
 */
export function initAuthView({ onLogin, onRegister }) {
  const tabs = $('#auth-tabs');
  const loginForm = $('#form-login');
  const regForm = $('#form-register');

  function showTab(name) {
    tabs.dataset.active = name;
    $$('.tabs__tab', tabs).forEach((t) => t.setAttribute('aria-selected', String(t.id === `tab-${name}`)));
    loginForm.hidden = name !== 'login';
    regForm.hidden = name !== 'register';
    $(name === 'login' ? '#login-username' : '#reg-username').focus();
  }
  $('#tab-login').addEventListener('click', () => showTab('login'));
  $('#tab-register').addEventListener('click', () => showTab('register'));

  // Показать/скрыть пароль
  $$('[data-toggle-password]').forEach((btn) => btn.addEventListener('click', () => {
    const input = $('#' + btn.dataset.togglePassword);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('use', btn).setAttribute('href', show ? '#i-eye-off' : '#i-eye');
    btn.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
  }));

  // --- Регистрация: проверка до отправки ---
  const regUser = $('#reg-username');
  const regPass = $('#reg-password');
  regPass.addEventListener('input', () => renderRules(regPass.value));
  regUser.addEventListener('input', () => { if (regUser.value) setFieldError(regUser, usernameError(regUser.value.trim())); else setFieldError(regUser, ''); });

  regForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = $('#register-error');
    showFormError(errBox, '');
    const username = regUser.value.trim();
    const password = regPass.value;

    const uErr = usernameError(username);
    setFieldError(regUser, uErr);
    renderRules(password);
    if (uErr || !isPasswordValid(password)) {
      if (!isPasswordValid(password)) showFormError(errBox, 'Пароль не соответствует требованиям ниже.');
      shake(regForm); haptic.error();
      return;
    }
    setBusy(regForm, true);
    try {
      await onRegister(username, password);
      haptic.success();
    } catch (err) {
      const f = err.fields || {};
      if (f.username_errors?.length) setFieldError(regUser, f.username_errors[0]);
      showFormError(errBox, [...(f.password_errors || []), f.password_errors?.length || f.username_errors?.length ? '' : err.message]);
      shake(regForm); haptic.error();
    } finally { setBusy(regForm, false); }
  });

  // --- Вход ---
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = $('#login-error');
    showFormError(errBox, '');
    const username = $('#login-username').value.trim();
    const password = $('#login-password').value;
    if (!username || !password) {
      showFormError(errBox, 'Введите имя пользователя и пароль.');
      shake(loginForm); haptic.error();
      return;
    }
    setBusy(loginForm, true);
    try {
      await onLogin(username, password);
      haptic.success();
    } catch (err) {
      showFormError(errBox, err.message);
      shake(loginForm); haptic.error();
    } finally { setBusy(loginForm, false); }
  });

  return {
    reset() {
      loginForm.reset(); regForm.reset(); renderRules('');
      showFormError($('#login-error'), ''); showFormError($('#register-error'), '');
      setFieldError(regUser, '');
      showTab('login');
    },
  };
}
