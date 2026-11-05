/* Окно редактора: выбирает режим (фото/видео), собирает результат.
   openEditor(file) → Promise<{file, cover, caption} | null> (null — пользователь закрыл окно). */
import { $ } from '../dom.js';
import { openModal, closeModal, onModalClose } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { createPhotoEditor } from './photo-editor.js';
import { createVideoEditor } from './video-editor.js';

let photo = null, video = null, wired = false;
let resolveCurrent = null, abort = null, mode = 'photo';

const modal = () => $('#modal-editor');

function busy(on, text = 'Обработка…') {
  $('#editor-busy').hidden = !on;
  $('#editor-busy-text').textContent = text;
  $('#editor-done').disabled = on;
}

function wire() {
  wired = true;
  photo = createPhotoEditor({
    stage: $('#editor-stage'), canvas: $('#editor-canvas'), cropBox: $('#crop-box'),
    textInput: $('#editor-text-input'), tools: $('#photo-tools'),
  });
  video = createVideoEditor({ video: $('#editor-video'), playBtn: $('#editor-play'), tools: $('#video-tools') });
  photo.onUndoChange((has) => { $('#editor-undo').disabled = !has; });
  $('#editor-undo').addEventListener('click', () => photo.undo());
  $('#editor-cancel').addEventListener('click', () => abort?.abort());

  $('#editor-done').addEventListener('click', async () => {
    busy(true, mode === 'photo' ? 'Сохраняем…' : 'Готовим видео…');
    abort = new AbortController();
    try {
      let result;
      if (mode === 'photo') {
        result = { file: await photo.export(), cover: null };
      } else {
        const r = await video.export({
          signal: abort.signal,
          onProgress: (p) => { $('#editor-busy-text').textContent = `Обрезаем видео… ${Math.round(p * 100)}%`; },
        });
        if (r.warning) toast(r.warning);
        result = { file: r.file, cover: r.cover };
      }
      finish({ ...result, caption: $('#editor-caption').value.trim() });
    } catch (e) {
      if (e.name !== 'AbortError') toast(e.message || 'Не удалось подготовить файл.');
    } finally {
      busy(false);
      abort = null;
    }
  });

  // Любое закрытие окна (крестик, Esc, подложка) без «Готово» = отмена
  onModalClose('modal-editor', () => {
    abort?.abort();
    photo.destroy(); video.destroy();
    if (resolveCurrent) { resolveCurrent(null); resolveCurrent = null; }
  });
}

function finish(result) {
  const resolve = resolveCurrent;
  resolveCurrent = null;                     // чтобы onModalClose не отправил null следом
  closeModal('modal-editor');
  resolve?.(result);
}

export async function openEditor(file) {
  if (!wired) wire();
  mode = file.type.startsWith('video/') ? 'video' : 'photo';
  modal().dataset.mode = mode;
  $('#editor-caption').value = '';
  $('#editor-title').textContent = mode === 'video' ? 'Видео' : 'Фото';
  $('#editor-undo').disabled = true;
  busy(false);

  return new Promise((resolve) => {
    resolveCurrent = resolve;
    openModal('modal-editor');
    // Ждём кадр: у окна должны появиться размеры, иначе canvas не вычислит масштаб
    requestAnimationFrame(() => requestAnimationFrame(async () => {
      try {
        await (mode === 'video' ? video.load(file) : photo.load(file));
      } catch (e) {
        toast(e.message || 'Не удалось открыть файл.');
        closeModal('modal-editor');
      }
    }));
  });
}
