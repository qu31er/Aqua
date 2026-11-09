/* Профиль канала: подписчикам — название, описание и ссылка; администратору — карандаш справа сверху для правки. */
import { $, el } from '../dom.js';
import { api } from '../api.js';
import { avatar } from './avatar.js';
import { toast } from './toast.js';
import { askText } from './dialogs.js';
import { openModal, closeModal } from './modal.js';

export function initChannelProfile({ onChange }) {
  let chat = null;

  function render() {
    const name = chat.title || 'Канал';
    $('#channel-big-avatar').replaceChildren(avatar(name, { user: { id: chat.id, display_name: name, avatar: null }, big: true }));
    $('#channel-big-name').textContent = name;
    $('#channel-subs').textContent = `${chat.members.length} подписч.`;
    const desc = $('#channel-desc');
    desc.textContent = chat.description || 'Описание не добавлено'; desc.classList.toggle('is-empty', !chat.description);
    $('#channel-link').textContent = chat.username ? `${location.origin}/@${chat.username}` : '—';
    $('#channel-edit').hidden = !chat.can_post;                     // карандаш — только администратору
  }

  $('#channel-edit').addEventListener('click', async () => {
    const title = await askText({ title: 'Название канала', value: chat.title || '', max: 64 });
    if (!title) return;
    const description = await askText({ title: 'Описание канала', value: chat.description || '', placeholder: 'О чём канал', max: 500, ok: 'Сохранить' });
    if (description === null) return;
    try {
      chat = await api.updateChannel(chat.id, { title, description });
      render(); onChange?.(chat); toast('Канал обновлён');
    } catch (e) { toast(e.message || 'Не удалось сохранить.'); }
  });

  return {
    open(c) { chat = c; render(); openModal('modal-channel'); },
    close: () => closeModal('modal-channel'),
    get chat() { return chat; },
  };
}
