import { palette } from '@centraid/design-tokens';
import type { TemplateEntry } from '../../app-shell-context.js';
import { iconSvg } from './iconSvg.js';
import buttonCss from '../ui/Button.module.css';
import styles from './templatePreview.module.css';
import { cx } from '../ui/cx.js';
import modalCss from '../styles/modal.module.css';

// Template preview — a modal showing a template's identity + blurb with a "Use
// this template" action. A body-portal overlay (modal + local module classes)
// so it's callable from any route. The clone/build action is the caller's
// (onUse), keeping this pure presentation.
export function openTemplatePreview(tmpl: TemplateEntry, onUse: (t: TemplateEntry) => void): void {
  const color = (palette as unknown as Record<string, string>)[tmpl.colorKey] || '#7C5BD9';

  const backdrop = document.createElement('div');
  backdrop.className = modalCss.backdrop ?? '';
  const card = document.createElement('div');
  card.className = cx(modalCss.card, styles.tmplPreview);
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
  closeBtn.className = cx(buttonCss.icon, modalCss.close);
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = iconSvg('X', 16, 1.7);
  closeBtn.addEventListener('click', close);
  card.append(closeBtn);

  const head = document.createElement('div');
  head.className = styles.tmplPreviewHead ?? '';
  const iconEl = document.createElement('div');
  iconEl.className = styles.tmplPreviewIcon ?? '';
  iconEl.style.background = color;
  iconEl.innerHTML = iconSvg(tmpl.iconKey, 28, 1.85);
  head.append(iconEl);
  const headText = document.createElement('div');
  headText.style.minWidth = '0';
  const eyebrow = document.createElement('div');
  eyebrow.className = styles.tmplPreviewEyebrow ?? '';
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
  note.className = styles.tmplPreviewNote ?? '';
  note.textContent =
    'Installs straight to your Apps, ready to use. The original template stays in the catalog.';
  card.append(note);

  const cancel = document.createElement('button');
  cancel.className = cx(buttonCss.btn, buttonCss.ghost);
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', close);
  const useBtn = document.createElement('button');
  useBtn.className = cx(buttonCss.btn, buttonCss.primary);
  useBtn.innerHTML = `${iconSvg('Sparkle', 13)}<span>Use this template</span>`;
  useBtn.addEventListener('click', () => {
    close();
    onUse(tmpl);
  });
  const actions = document.createElement('div');
  actions.className = modalCss.actions ?? '';
  actions.append(cancel, useBtn);
  card.append(actions);

  document.body.append(backdrop, card);
  setTimeout(() => useBtn.focus(), 30);
}
