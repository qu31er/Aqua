// Вход по почте: новый адрес → выбор имени; неверный адрес; старой формы пароля больше нет.
const { chromium } = require('playwright'); const { setup } = require('./mock.js');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch();
  const { page, be, errs } = await setup(b, { viewport: { width: 420, height: 820 } });
  await page.goto('http://127.0.0.1:8765/index.html');
  await page.waitForSelector('#form-email:not([hidden])');
  ok(await page.locator('#login-password').count() === 0 && await page.locator('#tab-register').count() === 0, 'старая форма с паролем удалена');
  await page.fill('#auth-email', 'nope'); await page.click('#form-email button[type=submit]');
  ok(await page.locator('#email-error').isVisible(), 'неверная почта — подсказка, запрос не уходит');
  ok(!be.reqs.includes('POST /auth/email/request'), 'запрос кода не отправлен для неверной почты');
  await page.fill('#auth-email', 'New@Example.org'); await page.click('#form-email button[type=submit]');
  await page.waitForSelector('#form-code:not([hidden])');
  await page.fill('#auth-code', '123456'); await page.click('#form-code button[type=submit]');
  await page.waitForSelector('#form-name:not([hidden])');
  ok(await page.locator('#form-name').isVisible(), 'новая почта — экран выбора имени');
  await page.fill('#auth-username', 'bad name!'); await page.click('#form-name button[type=submit]');
  ok(!be.reqs.includes('POST /auth/email/register'), 'некорректное имя не уходит на сервер');
  await page.fill('#auth-username', 'newbie'); await page.click('#form-name button[type=submit]');
  await page.waitForSelector('#chat-list .chat-item');
  ok(await page.locator('#app').getAttribute('data-screen') === 'chat', 'аккаунт создан, открыт мессенджер');
  ok(errs.length === 0, 'нет ошибок консоли: ' + JSON.stringify(errs));
  await b.close(); process.exit(fails ? 1 : 0);
})();
