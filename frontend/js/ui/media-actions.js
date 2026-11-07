/* Действия с медиа: сохранить в галерею (скачать/«поделиться» на телефоне) и переслать в другой чат. */
import { $, el } from '../dom.js';
import { api, mediaUrl } from '../api.js';
import { state, peerOf } from '../state.js';
import { avatar } from './avatar.js';
import { openModal, closeModal } from './modal.js';
import { toast } from './toast.js';

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
const touchDevice = () => window.matchMedia('(pointer: coarse)').matches;

/** Сохранить файл: на телефоне — системное меню «Сохранить в галерею/Фото», на компьютере — обычное скачивание. */
export async function saveToGallery(media) {
  try {
    const blob = await (await fetch(media.local ? media.url : mediaUrl(media.url))).blob();
    const type = media.mime || blob.type;
    const name = (media.name && /\.[a-z0-9]{2,4}$/i.test(media.name)) ? media.name : `aqua-${Date.now()}.${EXT[type] || 'bin'}`;
    const file = new File([blob], name, { type });
    if (touchDevice() && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return true; } catch (e) { if (e.name === 'AbortError') return false; }
    }
    const a = el('a', { href: URL.createObjectURL(file), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast('Файл сохранён.');
    return true;
  } catch { toast('Не удалось сохранить файл.'); return false; }
}

/** Сохранить GIF в «Сохранённые». */
export async function saveGif(media) {
  try { await api.saveGif(media.id); toast('GIF сохранена.'); return true; }
  catch (e) { toast(e.message || 'Не удалось сохранить GIF.'); return false; }
}

export const isGifMessage = (m) => Boolean(m.meta?.gif) || m.media?.mime === 'image/gif';

/** Выбор чата и отправка копии файла. */
export function forwardMessage(m) {
  const list = $('#forward-list');
  const chats = [...state.chats.values()];
  list.replaceChildren(...(chats.length ? chats.map((c) => {
    const peer = c.type === 'direct' ? peerOf(c) : null;
    const title = c.type === 'direct' ? (peer?.display_name || peer?.username || 'Чат') : c.title;
    return el('li', {}, el('button', { type: 'button', class: 'contacts__row', onclick: async () => {
      closeModal('modal-forward');
      try {
        const media = m.media?.id ? await api.cloneMedia(m.media.id) : null;
        if (!media) return;
        await api.sendMessage(c.id, null, media.id, m.meta?.gif ? { gif: true } : null, null);
        toast(`Отправлено: ${title}`);
      } catch (e) { toast(e.message || 'Не удалось переслать.'); }
    } }, avatar(title, { user: peer }), el('span', { class: 'contacts__name' }, el('b', { text: title }))));
  }) : [el('li', { class: 'contacts__empty', text: 'Чатов пока нет.' })]));
  openModal('modal-forward');
}
