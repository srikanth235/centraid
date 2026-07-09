import { palette } from '@centraid/design-tokens';
import type { TemplateEntry } from '../../app-shell-context.js';
import { iconSvg } from './iconSvg.js';

// Template preview — a modal showing a template's identity + blurb with a "Use
// this template" action. Ported from the vanilla app-cards.ts openTemplatePreview;
// a body-portal overlay (same modal-card / cd-tmpl-preview-* global classes) so
// it's callable from any route. The clone/build action is the caller's (onUse),
// keeping this pure presentation.
export function openTemplatePreview(tmpl: TemplateEntry, onUse: (t: TemplateEntry) => void): void {
  const color = (palette as unknown as Record<string, string>)[tmpl.colorKey] || '#7C5BD9';

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const card = document.createElement('div');
  card.className = 'modal-card cd-tmpl-preview';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', `Preview ${tmpl.name}`);

  const close = (): void => {
    backdrop.remove();
    card.remove();
    document.removeEventListener('keydown', onKey);
  };
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-icon modal-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = iconSvg('X', 16, 1.7);
  closeBtn.addEventListener('click', close);
  card.append(closeBtn);

  const head = document.createElement('div');
  head.className = 'cd-tmpl-preview-head';
  const iconEl = document.createElement('div');
  iconEl.className = 'cd-tmpl-preview-icon';
  iconEl.style.background = color;
  iconEl.innerHTML = iconSvg(tmpl.iconKey, 28, 1.85);
  head.append(iconEl);
  const headText = document.createElement('div');
  headText.style.minWidth = '0';
  const eyebrow = document.createElement('div');
  eyebrow.className = 'cd-tmpl-preview-eyebrow';
  eyebrow.textContent = `Template · v${tmpl.version}`;
  const h3 = document.createElement('h3');
  h3.textContent = tmpl.name;
  headText.append(eyebrow, h3);
  head.append(headText);
  card.append(head);

  const desc = document.createElement('p');
  desc.textContent = tmpl.desc;
  card.append(desc);
  const note = document.createElement('div');
  note.className = 'cd-tmpl-preview-note';
  note.textContent =
    'Clones into your apps as a draft. Rename, edit, and publish from there — the original template stays in the catalog.';
  card.append(note);

  const cancel = document.createElement('button');
  cancel.className = 'btn btn-ghost';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', close);
  const useBtn = document.createElement('button');
  useBtn.className = 'btn btn-primary';
  useBtn.innerHTML = `${iconSvg('Sparkle', 13)}<span>Use this template</span>`;
  useBtn.addEventListener('click', () => {
    close();
    onUse(tmpl);
  });
  const actions = document.createElement('div');
  actions.className = 'sheet-actions';
  actions.append(cancel, useBtn);
  card.append(actions);

  document.body.append(backdrop, card);
  setTimeout(() => useBtn.focus(), 30);
}
