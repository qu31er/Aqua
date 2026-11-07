// Тест: несколько аватарок, карусель, жест «потянуть вниз», удаление/«сделать основным», чужой профиль.
const { chromium } = require('playwright'); const { setup } = require('./mock.js'); const path = require('path');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const PNG = path.join(__dirname, 'fixtures', 'photo.jpg');
(async () => {
  const b = await chromium.launch();
  const t = await setup(b, { viewport: { width: 420, height: 800 }, hasTouch: true });
  const { page, be, errs } = t;
  await page.addInitScript(() => { localStorage.setItem('aqua.token', 'tok'); sessionStorage.setItem('aqua.splash.seen', '1'); });
  await page.goto('http://127.0.0.1:8765/index.html'); await page.waitForSelector('#chat-list .chat-item');
  await page.click('#btn-menu'); await page.waitForSelector('#modal-settings.is-open');
  ok(await page.locator('#avatar-viewer').isHidden(), 'карусель закрыта');
  await page.click('#profile-avatar'); await page.waitForTimeout(200);
  ok(await page.locator('#avatar-viewer').isHidden(), 'без фото карусель не открывается');

  // Добавляем два фото
  for (let i = 0; i < 2; i++) { await page.setInputFiles('#avatar-file', PNG); await page.waitForTimeout(250); }
  ok(be.gallery.length === 2 && be.profilePatches.filter((p) => p.avatar_id).length === 2, 'два фото загружены и сделаны аватаркой');
  ok(await page.locator('#profile-avatar img.avatar__img').count() === 1, 'текущая аватарка показана');

  // Открытие по нажатию
  await page.click('#profile-avatar'); await page.waitForSelector('#avatar-viewer:not([hidden])');
  ok(await page.locator('.avv__slide').count() === 2 && await page.locator('#avv-dots i').count() === 2, 'в карусели 2 фото и 2 индикатора');
  ok(await page.locator('#avv-menu-wrap').isVisible(), 'у своего профиля есть меню ⋮');
  await page.screenshot({ path: 'tests/shots/avatar-viewer.png' });
  // Листание
  await page.evaluate(() => { const t = document.querySelector('#avv-track'); t.scrollTo({ left: t.clientWidth, behavior: 'instant' }); });
  await page.waitForFunction(() => document.querySelectorAll('#avv-dots i')[1].classList.contains('is-on'));
  ok(true, 'индикатор переключился на второе фото');
  await page.click('#avv-more');
  ok(await page.locator('#avv-act-main').isVisible(), 'для не основного фото есть «Сделать основным»');
  const second = be.gallery[1];
  await page.click('#avv-act-main');
  await page.waitForFunction((id) => document.querySelectorAll('.avv__slide').length === 2, second);
  ok(be.me.avatar.id === second, 'второе фото стало основным');
  // Удаление
  await page.click('#avv-more'); await page.click('#avv-act-delete');
  await page.waitForFunction(() => document.querySelectorAll('.avv__slide').length === 1);
  ok(be.gallery.length === 1, 'фото удалено на сервере, осталось одно');
  await page.click('#avv-more'); await page.click('#avv-act-delete');
  await page.waitForSelector('#avatar-viewer', { state: 'hidden' });
  ok(be.gallery.length === 0 && be.me.avatar === null, 'удалено последнее: карусель закрылась, аватарки нет');

  // Жест «потянуть вниз» в своём профиле
  await page.setInputFiles('#avatar-file', PNG); await page.waitForTimeout(250);
  const pull = (sel) => page.evaluate((s) => {
    const body = document.querySelector(s); const mk = (y) => new Touch({ identifier: 1, target: body, clientX: 200, clientY: y });
    body.dispatchEvent(new TouchEvent('touchstart', { touches: [mk(300)], bubbles: true }));
    body.dispatchEvent(new TouchEvent('touchmove', { touches: [mk(420)], bubbles: true }));
    body.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));
  }, sel);
  await pull('#modal-settings .modal__body');
  await page.waitForSelector('#avatar-viewer:not([hidden])');
  ok(true, 'потянув вниз в профиле, открылась карусель');
  await page.keyboard.press('Escape'); await page.waitForSelector('#avatar-viewer', { state: 'hidden' });
  ok(await page.locator('#modal-settings.is-open').count() === 1, 'Esc закрыл только карусель');
  await page.click('#modal-settings .btn-icon[data-close-modal]');

  // Чужой профиль: нет меню, жест работает
  await page.click('.chat-item[data-chat-id="1"]');
  await page.waitForSelector('#messages .msg');
  await page.click('#chat-peer'); await page.waitForSelector('#modal-peer.is-open');
  await pull('#modal-peer .modal__body');
  await page.waitForSelector('#avatar-viewer:not([hidden])');
  ok(await page.locator('.avv__slide').count() === 2, 'в чужом профиле открылась карусель из 2 фото');
  ok(await page.locator('#avv-menu-wrap').isHidden(), 'у чужого профиля меню ⋮ нет');
  await page.click('#avv-close'); ok(await page.locator('#avatar-viewer').isHidden(), 'крестик закрывает');
  ok(errs.length === 0, 'нет ошибок консоли: ' + JSON.stringify(errs.slice(0, 3)));
  await b.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
