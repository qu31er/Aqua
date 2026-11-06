// Мок бэкенда Aqua для Playwright: те же маршруты и форматы, что у backend/app/routers.
const iso = (m) => new Date(Date.now() - m * 60000).toISOString();

// 4 секунды тишины в WAV — чтобы <audio> реально загружался и играл в тестах голосовых
function silentWav(seconds = 4, rate = 8000) {
  const n = seconds * rate, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  return buf;
}

function makeBackend() {
  const me = { id: 1, username: 'alice', online: true, last_seen: null };
  const bob = { id: 2, username: 'bob', online: true, last_seen: null };
  const carl = { id: 3, username: 'carl', online: false, last_seen: iso(300) };
  let mid = 0, mediaId = 0;
  const msgs = { 1: [], 2: [] }, media = {}, reactions = {};
  const reactionsOf = (id) => Object.entries(reactions[id] || {})
    .filter(([, u]) => u.length).map(([emoji, users]) => ({ emoji, count: users.length, users: [...users] }));
  const add = (chat, sender, text, ago, extra = {}) => {
    const m = { id: ++mid, chat_id: chat, sender: { id: sender.id, username: sender.username }, kind: 'text', text,
      media: null, meta: null, reactions: [], created_at: iso(ago), ...extra };
    msgs[chat].push(m); return m;
  };
  // Начальные данные: длинная история с bob (для проверки подгрузки) и одно сообщение от carl
  for (let i = 0; i < 120; i++) add(1, i % 2 ? me : bob, 'старое сообщение ' + i, 2000 - i * 10);
  add(1, bob, 'Привет! Как дела?', 5);
  add(2, carl, 'Скинул макеты', 90);
  const hidden = new Set();                           // «удалено у себя»
  const lastOf = (c) => msgs[c].filter((x) => !hidden.has(x.id)).at(-1) || null;
  const chats = () => [
    { id: 1, type: 'direct', title: 'bob', created_at: iso(9999), members: [me, bob], last_message: lastOf(1) },
    { id: 2, type: 'direct', title: 'carl', created_at: iso(9999), members: [me, carl], last_message: lastOf(2) }];
  const toggle = (id, emoji, userId) => {
    const r = (reactions[id] ??= {}); const u = (r[emoji] ??= []);
    const i = u.indexOf(userId); if (i >= 0) u.splice(i, 1); else u.push(userId);
    const m = Object.values(msgs).flat().find((x) => x.id === id); if (m) m.reactions = reactionsOf(id);
    return reactionsOf(id);
  };
  return { hidden, me, bob, carl, msgs, media, chats, add, toggle, reactionsOf, reqs: [], deleted: [], wsIn: [], uploads: [],
    newMedia: (o) => (media[++mediaId] = { id: mediaId, ...o }) };
}

/** Открывает страницу с моками. opts.splash=true — не пропускать заставку. */
async function setup(browser, ctxOpts = {}, opts = {}) {
  const be = makeBackend();
  const ctx = await browser.newContext(ctxOpts);
  await ctx.addInitScript((showSplash) => {
    window.__vib = []; navigator.vibrate = (p) => { window.__vib.push(p); return true; };
    if (!showSplash) { try { sessionStorage.setItem('aqua.splash.seen', '1'); } catch {} }
  }, Boolean(opts.splash));
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|start\.mp4|media/i.test(m.text())) errs.push(m.text()); });

  let wsRoute = null;
  const push = (o) => wsRoute.send(JSON.stringify(o));
  await page.routeWebSocket(/\/ws$/, (ws) => {
    wsRoute = ws;
    ws.onMessage((raw) => {
      const d = JSON.parse(raw); be.wsIn.push(d);
      if (d.type === 'auth') ws.send(JSON.stringify({ type: 'ready', user: be.me }));
      if (d.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      if (d.type === 'message') {
        const md = d.media_id ? be.media[d.media_id] : null;
        const m = be.add(d.chat_id, be.me, d.text, 0, md ? {
          kind: md.kind, meta: d.meta ?? null,
          cover: d.cover_id && be.media[d.cover_id] ? { id: d.cover_id, url: `/api/media/${d.cover_id}` } : null,
          media: { id: md.id, url: `/api/media/${md.id}`, name: md.name, mime: md.mime, size: md.size } } : {});
        setTimeout(() => ws.send(JSON.stringify({ type: 'message', message: m, client_id: d.client_id })), 80);
      }
    });
  });
  await page.route('**/api/**', async (route) => {
    const req = route.request(); const u = new URL(req.url()); const path = u.pathname.replace('/api', '');
    be.reqs.push(req.method() + ' ' + path);
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/auth/register') return json(201, { token: 'tok', token_type: 'bearer', user: be.me });
    if (path === '/auth/login') return req.postDataJSON().password === 'secret123'
      ? json(200, { token: 'tok', token_type: 'bearer', user: be.me }) : json(401, { detail: 'Неверное имя пользователя или пароль.' });
    if (path === '/auth/me') return json(200, be.me);
    if (path === '/chats' && req.method() === 'GET') return json(200, be.chats());
    let m = path.match(/^\/chats\/(\d+)\/messages$/);
    if (m && req.method() === 'GET') {
      const before = +u.searchParams.get('before_id') || Infinity, lim = +u.searchParams.get('limit');
      return json(200, be.msgs[m[1]].filter((x) => x.id < before).slice(-lim));
    }
    if (path === '/users/search') return json(200, [be.carl, { id: 4, username: 'dave', online: false, last_seen: null }].filter((x) => x.username.includes(u.searchParams.get('q'))));
    m = path.match(/^\/messages\/(\d+)$/);
    if (m && (req.method() === 'PATCH' || req.method() === 'DELETE')) {
      const id = +m[1];
      const [chat, list] = Object.entries(be.msgs).find(([, a]) => a.some((x) => x.id === id)) || [];
      if (!list) return json(404, { detail: 'Сообщение не найдено.' });
      const msg = list.find((x) => x.id === id);
      if (req.method() === 'PATCH') {
        if (msg.sender.id !== be.me.id) return json(403, { detail: 'Можно изменять только свои сообщения.' });
        const text = (JSON.parse(req.postData() || '{}').text || '').trim();
        if (!text && msg.kind === 'text') return json(400, { detail: 'Сообщение не может быть пустым.' });
        msg.text = text || null; msg.edited_at = iso(0);
        setTimeout(() => push({ type: 'message_edited', message: msg }), 20);
        return json(200, msg);
      }
      const scope = u.searchParams.get('scope');
      if (scope === 'all' && msg.sender.id !== be.me.id) return json(403, { detail: 'Удалить у всех можно только свои сообщения.' });
      be.deleted.push({ id, scope });
      if (scope === 'all') list.splice(list.indexOf(msg), 1); else be.hidden.add(id);
      const rest = list.filter((x) => !(be.hidden?.has(x.id)));
      setTimeout(() => push({ type: 'message_deleted', chat_id: +chat, message_id: id, scope, last_message: rest.at(-1) || null }), 20);
      return json(200, { ok: true, chat_id: +chat, message_id: id, scope });
    }
    m = path.match(/^\/messages\/(\d+)\/reactions$/);
    if (m && req.method() === 'PUT') {
      const id = +m[1], emoji = req.postDataJSON().emoji;
      const list = be.toggle(id, emoji, 1);
      const chat = Object.entries(be.msgs).find(([, a]) => a.some((x) => x.id === id))[0];
      setTimeout(() => push({ type: 'reaction', chat_id: +chat, message_id: id, reactions: list }), 20); // как сервер: рассылка всем
      return json(200, { message_id: id, reactions: list });
    }
    if (path === '/media' && req.method() === 'POST') {
      const body = req.postDataBuffer(); const ct = req.headers()['content-type'] || '';
      be.uploads.push({ ct, size: body?.length ?? 0, text: body?.toString('latin1').slice(0, 300) });
      const head = body?.toString('latin1').slice(0, 400) ?? '';
      const name = (head.match(/filename="([^"]*)"/) || [])[1] || 'file';
      const mime = ((head.match(/Content-Type:\s*([^\r\n;]+)/i) || [])[1] || 'application/octet-stream').trim();
      const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'voice' : 'file';
      const rec = be.newMedia({ kind, name, mime, size: body?.length ?? 0, bytes: body, created_at: iso(0) });
      be.uploads[be.uploads.length - 1].meta = { name, mime, kind };
      const { bytes, ...pub } = rec;
      return json(201, { ...pub, url: `/api/media/${rec.id}` });
    }
    if (path === '/gifs/status') return json(200, { enabled: be.gifsEnabled !== false, provider: 'giphy' });
    if (path === '/gifs/search') {
      const q = u.searchParams.get('q'), pos = +u.searchParams.get('pos');
      be.gifQueries = (be.gifQueries || []); be.gifQueries.push(q + '@' + pos);
      const items = Array.from({ length: 6 }, (_, i) => ({ id: `g${pos + i}`, title: `${q || 'hot'} ${pos + i}`, preview: `https://media.giphy.com/p${pos + i}.gif`, url: `https://media.giphy.com/f${pos + i}.gif`, w: 200, h: 120 + i * 20 }));
      return json(200, { items, next: pos < 6 ? pos + 6 : null });
    }
    if (path === '/gifs/proxy') return route.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAKLRjwAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64') });
    if (path === '/gifs/import' && req.method() === 'POST') {
      (be.gifImports = be.gifImports || []).push(req.postDataJSON().url);
      const rec = be.newMedia({ kind: 'image', name: 'gif-1.gif', mime: 'image/gif', size: 43, created_at: iso(0) });
      const { bytes, ...pub } = rec; return json(201, { ...pub, url: `/api/media/${rec.id}` });
    }
    if (path === '/media/summary') {
      const out = { image: 0, video: 0, voice: 0, file: 0 };
      Object.values(be.media).forEach((x) => { out[x.kind]++; });
      return json(200, out);
    }
    if (path === '/media' && req.method() === 'GET') {
      const k = u.searchParams.get('kind');
      return json(200, Object.values(be.media).filter((x) => !k || x.kind === k).reverse()
        .map(({ bytes, ...x }) => ({ ...x, url: `/api/media/${x.id}` })));
    }
    m = path.match(/^\/media\/(\d+)$/);
    if (m) {
      const md = be.media[m[1]];
      if (md?.bytes && md.kind !== 'voice') {   // отдаём то, что загрузили (тело multipart → вырезаем содержимое файла)
        const b = md.bytes, start = b.indexOf('\r\n\r\n') + 4, end = b.lastIndexOf('\r\n--');
        return route.fulfill({ status: 200, contentType: md.mime, body: b.subarray(start, end) });
      }
      if (md?.seed) return route.fulfill({ status: 200, contentType: md.mime, body: md.seed });
      return route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() });
    }
    return json(404, { detail: 'no mock' });
  });
  return { page, ctx, be, errs, push };
}
module.exports = { makeBackend, setup, iso, silentWav };
