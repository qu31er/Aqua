/* Аватар с инициалами и индикатором «онлайн». */
import { el } from '../dom.js';
import { initials, hueFor } from '../format.js';

export function avatar(name, { online = false, small = false } = {}) {
  return el('span', {
      class: `avatar${small ? ' avatar--sm' : ''}${online ? ' is-online' : ''}`,
      style: `--hue:${hueFor(name)}`,
      'aria-hidden': 'true',
    },
    initials(name),
    el('span', { class: 'avatar__dot' }),
  );
}
