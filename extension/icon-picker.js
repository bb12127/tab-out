/* ================================================================
   icon-picker.js — workspace emoji picker popover

   Anchored to the clicked workspace's edit pencil. Contents are built
   from EMOJI_CATEGORIES plus a free-form input so any emoji
   (e.g. from Windows' Win+. picker) can be used.
   ================================================================ */

'use strict';


// Curated emoji library used by the workspace icon picker.
// Grouped by category; the free-form input below accepts anything else.
export const EMOJI_CATEGORIES = [
  { name: 'Work',    emojis: ['💼','📊','📈','📉','💻','🖥️','⌨️','🖨️','📱','📞','✉️','📧','📫','📎','📌','📍','🗂️','📁','📂','📋','📝','✏️','🖊️','📅','📆','🗓️','⏰','⏱️','🔖','💡'] },
  { name: 'Money',   emojis: ['💰','💵','💳','💎','🏦','💹','🧾','🪙'] },
  { name: 'Food',    emojis: ['🍳','🍽️','🍔','🍕','🥗','🍜','🍣','🍱','🥟','🍰','🎂','☕','🍵','🍷','🍺','🥤','🍎','🥐','🍪','🌮','🍿','🥞','🧇','🥙','🥘','🧃'] },
  { name: 'Nature',  emojis: ['🌿','🌱','🌳','🌺','🌸','🌻','🌞','🌙','⭐','🌈','☀️','🔥','💧','🌊','🏔️','⛰️','🏝️','🏖️','🌍','🌵','🍄'] },
  { name: 'Travel',  emojis: ['✈️','🚗','🚕','🚂','🚢','⚓','🚀','🏍️','🚲','🛫','🗺️','🏨','🛣️'] },
  { name: 'Home',    emojis: ['🏠','🏡','🛋️','🛏️','🚪','🧹','🧺','📦','🎁','🔑','🔒','🔨','🛠️','🔧','⚙️','🧰','🧲','🧼','🪑'] },
  { name: 'Play',    emojis: ['🎮','🎨','🎵','🎸','🎹','🎧','📷','🎬','📚','📖','🎯','🎲','🧩','🪁','🎭','🎪','🕹️','🎤'] },
  { name: 'Sport',   emojis: ['🧘','🏃','🚴','🏊','⚽','🏀','🏈','🏐','🎾','🏓','🥊','🥋','🏆','🥇','🏅','⛷️','🏂','🏋️','🤸'] },
  { name: 'Animals', emojis: ['🐶','🐱','🐭','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐷','🐸','🐵','🐔','🦆','🐦','🐧','🐢','🐟','🐳','🦋','🐝','🐙','🦉','🦖'] },
  { name: 'People',  emojis: ['👤','👥','🧠','👁️','👋','👍','👎','✌️','🤝','💪','🫶','🧑‍💻','🧑‍🍳','🧑‍🎨','🧑‍🔬','🧑‍🏫','🧑‍⚕️','🧑‍🔧','🧑‍💼','🧑‍🌾'] },
  { name: 'Heart',   emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💖','💗','💘','💝','💓','💔'] },
  { name: 'Symbol',  emojis: ['✨','💫','⭐','🌟','💥','🔥','⚡','💯','✅','🎉','🎊','❓','❗','💬','🔔','🔕','🎫','🏷️','🔱','♾️','🚧','⚠️','☑️','🆕','🆗','🆒','🔸','🔹','🟢','🟡','🔴','🟣','🟠','⚫','⚪'] },
];


export function openIconPicker(anchorEl, workspaceName) {
  const picker = document.getElementById('iconPicker');
  if (!picker || !anchorEl) return;

  const escape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safeName = escape(workspaceName);

  const categoriesHtml = EMOJI_CATEGORIES.map(cat => {
    const options = cat.emojis.map(e =>
      `<button class="icon-picker-option" data-action="pick-icon" data-icon="${escape(e)}" title="${escape(e)}">${escape(e)}</button>`
    ).join('');
    return `<div class="icon-picker-section">
      <div class="icon-picker-section-label">${escape(cat.name)}</div>
      <div class="icon-picker-grid">${options}</div>
    </div>`;
  }).join('');

  picker.dataset.workspaceName = workspaceName;
  picker.innerHTML = `
    <div class="icon-picker-header">
      <span>Pick an icon for <strong>${safeName}</strong></span>
      <button class="icon-picker-close" data-action="close-icon-picker" title="Close">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>
    <div class="icon-picker-body">${categoriesHtml}</div>
    <div class="icon-picker-footer">
      <input type="text" class="icon-picker-input" id="iconPickerInput" placeholder="Or paste / type any emoji (Win+. on Windows)" maxlength="8">
      <button class="icon-picker-clear" data-action="clear-icon">Clear</button>
    </div>
  `;

  // Show first so offsetWidth/Height are real, then position.
  picker.style.display = 'block';
  picker.style.visibility = 'hidden';

  const anchorRect = anchorEl.getBoundingClientRect();
  const pickerRect = picker.getBoundingClientRect();
  const margin = 8;

  let top = anchorRect.bottom + window.scrollY + 6;
  let left = anchorRect.left + window.scrollX;

  // Keep inside viewport horizontally
  const maxLeft = window.scrollX + document.documentElement.clientWidth - pickerRect.width - margin;
  if (left > maxLeft) left = maxLeft;
  if (left < margin) left = margin;

  // If it would overflow the bottom, flip above the anchor
  const viewportBottom = window.scrollY + document.documentElement.clientHeight;
  if (top + pickerRect.height + margin > viewportBottom) {
    top = anchorRect.top + window.scrollY - pickerRect.height - 6;
    if (top < window.scrollY + margin) top = window.scrollY + margin;
  }

  picker.style.top  = top + 'px';
  picker.style.left = left + 'px';
  picker.style.visibility = 'visible';

  // Autofocus the free-form input so Win+. / paste works immediately
  const input = document.getElementById('iconPickerInput');
  if (input) input.focus();
}

export function closeIconPicker() {
  const picker = document.getElementById('iconPicker');
  if (!picker) return;
  picker.style.display = 'none';
  picker.innerHTML = '';
  delete picker.dataset.workspaceName;
}
