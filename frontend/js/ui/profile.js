/* Окно профиля: аватар, ник, @логин, описание; редактирование и выбор системной аватарки. */
import { $ } from '../dom.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { avatar } from './avatar.js';
import { toast } from './toast.js';

export const AVATAR_PRESETS = ['wave', 'fish', 'shell', 'anchor', 'starfish', 'sun', 'moon', 'drop', 'boat', 'jelly', 'turtle', 'pearl'];
const PRESET_NAMES = { wave: 'Волна', fish: 'Рыбка', shell: 'Ракушка', anchor: 'Якорь', starfish: 'Морская звезда', sun: 'Солнце', moon: 'Луна', drop: 'Капля', boat: 'Лодка', jelly: 'Медуза', turtle: 'Черепаха', pearl: 'Жемчужина' };

export const displayName = (u) => u.display_name || u.username;

/** onChange(user) вызывается после сохранения, чтобы приложение обновило состояние и списки. */
export function initProfile({ onChange }) {
  let draft = null;      // {avatar} — выбранная, но ещё не сохранённая аватарка

  const setEditing = (on) => {
    $('#profile-view').hidden = on; $('#profile-edit').hidden = !on;
    $('#profile-footer').hidden = !on;
    $('#modal-settings-title').textContent = on ? 'Изменить профиль' : 'Профиль';
  };

  function renderView() {
    const u = state.user;
    $('#profile-avatar').replaceChildren(avatar(displayName(u), { user: u, big: true }));
    $('#profile-name').textContent = displayName(u);
    $('#profile-login').textContent = `@${u.username}`;
    const bio = $('#profile-bio');
    bio.textContent = u.bio || 'Описание не добавлено';
    bio.classList.toggle('is-empty', !u.bio);
  }

  function renderDraftAvatar() {
    const u = { ...state.user, avatar: draft.avatar };
    $('#profile-avatar-edit').replaceChildren(avatar($('#profile-nick').value.trim() || state.user.username, { user: u, big: true }));
    const cur = draft.avatar?.preset;
    $('#avatar-picker').querySelectorAll('.avatar-picker__item').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.preset === cur)));
  }

  function buildPicker() {
    $('#avatar-picker').replaceChildren(...AVATAR_PRESETS.map((id) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'avatar-picker__item'; b.dataset.preset = id;
      b.setAttribute('role', 'radio'); b.setAttribute('aria-label', PRESET_NAMES[id]); b.title = PRESET_NAMES[id];
      const img = document.createElement('img'); img.src = `assets/avatars/${id}.svg`; img.alt = ''; img.draggable = false;
      b.append(img);
      return b;
    }));
  }
  buildPicker();

  $('#avatar-picker').addEventListener('click', (e) => {
    const b = e.target.closest('.avatar-picker__item'); if (!b) return;
    draft.avatar = { preset: b.dataset.preset }; draft.file = null; renderDraftAvatar();
  });
  $('#avatar-reset').addEventListener('click', () => { draft.avatar = null; draft.file = null; renderDraftAvatar(); });
  $('#avatar-upload').addEventListener('click', () => $('#avatar-file').click());
  $('#profile-avatar-edit').addEventListener('click', () => $('#avatar-file').click());
  $('#avatar-file').addEventListener('change', () => {
    const f = $('#avatar-file').files[0]; $('#avatar-file').value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')) { toast('Выберите картинку.'); return; }
    // Загрузим при сохранении; пока показываем локальное превью
    draft.file = f; draft.avatar = { url: null, local: URL.createObjectURL(f) }; renderDraftAvatar();
  });
  $('#profile-nick').addEventListener('input', () => { if (!draft?.avatar) renderDraftAvatar(); });

  const startEdit = () => {
    const u = state.user;
    draft = { avatar: u.avatar ?? null, file: null };
    $('#profile-nick').value = displayName(u);
    $('#profile-login-ro').value = `@${u.username}`;
    $('#profile-bio-input').value = u.bio || '';
    setEditing(true); renderDraftAvatar();
  };
  $('#profile-edit-btn').addEventListener('click', startEdit);
  $('#profile-photo-btn').addEventListener('click', () => { startEdit(); $('#avatar-file').click(); });
  $('#profile-cancel').addEventListener('click', () => { draft = null; setEditing(false); });

  $('#profile-save').addEventListener('click', async () => {
    if (!$('#profile-nick').value.trim()) { toast('Укажите ник.'); $('#profile-nick').focus(); return; }
    const btn = $('#profile-save'); btn.disabled = true;
    try {
      const body = { display_name: $('#profile-nick').value, bio: $('#profile-bio-input').value };
      if (draft.file) body.avatar_id = (await api.uploadMedia(draft.file)).id;
      else if (draft.avatar?.preset) body.avatar_preset = draft.avatar.preset;
      else if (!draft.avatar) { body.avatar_id = null; body.avatar_preset = null; }
      const updated = await api.updateProfile(body);
      draft = null; setEditing(false);
      onChange(updated);
      toast('Профиль сохранён');
    } catch (e) { toast(e.message || 'Не удалось сохранить профиль.'); }
    finally { btn.disabled = false; }
  });

  return {
    /** Вызывать при каждом открытии окна и после изменения профиля. */
    render() { draft = null; setEditing(false); renderView(); },
  };
}
