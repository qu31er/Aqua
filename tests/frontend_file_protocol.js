// Проверка: при открытии index.html как файла показывается подсказка, а форма не перезагружает страницу.
const { chromium } = require('playwright'); const path = require('path');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  await p.goto('file://' + path.resolve(__dirname, '../frontend/index.html'));
  await p.waitForSelector('#boot-banner', { timeout: 3000 });
  const marker = await p.evaluate(() => (window.__m = 1));
  await p.fill('#auth-email', 'alice@example.com');
  await p.click('#form-email button[type=submit]'); await p.waitForTimeout(300);
  const same = await p.evaluate(() => window.__m === 1);
  console.log((same ? 'PASS' : 'FAIL') + ' форма не перезагружает страницу при file://');
  console.log('PASS подсказка:', (await p.textContent('#boot-banner')).slice(0, 60));
  await b.close(); process.exit(same ? 0 : 1);
})();
