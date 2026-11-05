/* Редактор видео: предпросмотр, обрезка начала/конца (две ручки), выбор обложки. */
import { el, icon } from '../dom.js';
import { trimVideo, captureCover, canTrim } from './video-trim.js';

const MIN_LEN = 0.5;                                    // минимальная длина после обрезки, с
const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

/** У webm из MediaRecorder duration бывает Infinity — «прокручиваем» в конец, чтобы браузер её узнал. */
async function readDuration(video) {
  if (Number.isFinite(video.duration)) return video.duration;
  await new Promise((resolve) => {
    video.addEventListener('timeupdate', resolve, { once: true });
    video.currentTime = 1e6;
  });
  const d = video.duration;
  video.currentTime = 0;
  return d;
}

/** @param {{video:HTMLVideoElement, playBtn:HTMLElement, tools:HTMLElement}} ui */
export function createVideoEditor({ video, playBtn, tools }) {
  let file = null, url = null, duration = 0, start = 0, end = 0, coverTime = 0;

  const startH = el('button', { class: 'trim__handle', type: 'button', role: 'slider', 'aria-label': 'Начало' });
  const endH = el('button', { class: 'trim__handle', type: 'button', role: 'slider', 'aria-label': 'Конец' });
  const range = el('div', { class: 'trim__range' });
  const head = el('div', { class: 'trim__head' });
  const track = el('div', { class: 'trim__track' }, range, startH, endH, head);
  const tStart = el('span'), tLen = el('b'), tEnd = el('span');
  const coverRange = el('input', { type: 'range', min: 0, max: 1000, value: 0, class: 'cover__range', 'aria-label': 'Кадр обложки' });
  const coverLabel = el('span', { class: 'editor__hint' });

  tools.replaceChildren(
    el('div', { class: 'trim' }, el('p', { class: 'editor__label', text: 'Обрезка' }), track,
      el('div', { class: 'trim__times' }, tStart, tLen, tEnd)),
    el('div', { class: 'cover' }, el('p', { class: 'editor__label', text: 'Обложка (кадр)' }), coverRange, coverLabel),
  );

  const pct = (t) => `${(t / duration) * 100}%`;
  function paint() {
    track.style.setProperty('--s', pct(start));
    track.style.setProperty('--e', pct(end));
    tStart.textContent = fmt(start); tEnd.textContent = fmt(end); tLen.textContent = `${fmt(end - start)} с`;
    startH.setAttribute('aria-valuenow', start.toFixed(1)); endH.setAttribute('aria-valuenow', end.toFixed(1));
    coverTime = Math.min(end, Math.max(start, coverTime));
    coverRange.value = end > start ? Math.round(((coverTime - start) / (end - start)) * 1000) : 0;
    coverLabel.textContent = `Кадр на ${fmt(coverTime)}`;
  }

  /* Перетаскивание ручек */
  function bindHandle(handle, which) {
    const move = (clientX) => {
      const r = track.getBoundingClientRect();
      const t = Math.min(duration, Math.max(0, ((clientX - r.left) / r.width) * duration));
      if (which === 'start') start = Math.min(t, end - MIN_LEN);
      else end = Math.max(t, start + MIN_LEN);
      video.pause();
      video.currentTime = which === 'start' ? start : Math.max(start, end - 0.05);
      paint();
    };
    handle.addEventListener('pointerdown', (e) => { handle.setPointerCapture(e.pointerId); handle.dataset.drag = '1'; e.preventDefault(); });
    handle.addEventListener('pointermove', (e) => { if (handle.dataset.drag) move(e.clientX); });
    const stop = () => { delete handle.dataset.drag; };
    handle.addEventListener('pointerup', stop); handle.addEventListener('pointercancel', stop);
    handle.addEventListener('keydown', (e) => {                      // доступность: стрелки двигают на 0.1 с
      const step = e.key === 'ArrowLeft' ? -0.1 : e.key === 'ArrowRight' ? 0.1 : 0;
      if (!step) return;
      e.preventDefault();
      const r = track.getBoundingClientRect();
      const cur = (which === 'start' ? start : end) + step;
      move(r.left + (cur / duration) * r.width);
    });
  }
  bindHandle(startH, 'start');
  bindHandle(endH, 'end');

  coverRange.addEventListener('input', () => {
    coverTime = start + ((end - start) * coverRange.value) / 1000;
    video.pause();
    video.currentTime = coverTime;
    coverLabel.textContent = `Кадр на ${fmt(coverTime)}`;
  });

  /* Воспроизведение только внутри выбранного отрезка */
  const setPlayIcon = (playing) => {
    playBtn.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
    playBtn.setAttribute('aria-label', playing ? 'Пауза' : 'Воспроизвести');
    playBtn.classList.toggle('is-playing', playing);
  };
  playBtn.addEventListener('click', () => {
    if (!video.paused) { video.pause(); return; }
    if (video.currentTime < start || video.currentTime >= end - 0.05) video.currentTime = start;
    video.play().catch(() => {});
  });
  video.addEventListener('click', () => playBtn.click());
  video.addEventListener('play', () => setPlayIcon(true));
  video.addEventListener('pause', () => setPlayIcon(false));
  video.addEventListener('timeupdate', () => {
    if (!video.paused && video.currentTime >= end - 0.03) { video.pause(); video.currentTime = start; }
    head.style.left = pct(Math.min(duration, video.currentTime));
  });

  return {
    async load(f) {
      file = f;
      url = URL.createObjectURL(f);
      video.src = url;
      await new Promise((resolve, reject) => {
        video.addEventListener('loadedmetadata', resolve, { once: true });
        video.addEventListener('error', () => reject(new Error('Не удалось открыть видео. Возможно, формат не поддерживается браузером.')), { once: true });
      });
      duration = await readDuration(video);
      start = 0; end = duration; coverTime = Math.min(0.1, duration / 2);
      video.currentTime = coverTime;
      setPlayIcon(false);
      paint();
    },

    /** @returns {Promise<{file:File, cover:File|null, trimmed:boolean, warning?:string}>} */
    async export({ onProgress, signal } = {}) {
      video.pause();
      let cover = null;
      try { cover = await captureCover(video, coverTime); } catch { /* без обложки — не критично */ }
      const needsTrim = start > 0.05 || end < duration - 0.05;
      if (!needsTrim) return { file, cover, trimmed: false };                 // без перекодирования — без потерь
      if (!canTrim()) return { file, cover, trimmed: false, warning: 'Браузер не умеет обрезать видео — отправлено целиком.' };
      const trimmed = await trimVideo(file, start, end, { onProgress, signal });
      return { file: trimmed, cover, trimmed: true };
    },

    get range() { return { start, end, duration }; },
    destroy() {
      video.pause(); video.removeAttribute('src'); video.load();
      if (url) URL.revokeObjectURL(url);
      file = url = null;
    },
  };
}
