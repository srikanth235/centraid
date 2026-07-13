import type { TemplateEntry } from '../../app-shell-context.js';
import { INTEGRATION_HUES } from '../format.js';
import { iconSvg } from './iconSvg.js';
import styles from './automationTemplatePreview.module.css';
import au from '../styles/automation.module.css';
import { cx } from '../ui/cx.js';

// Automation-template preview — the richer drawer for an automation template
// (emoji, trigger, what-it-does steps, integration chips, "Use template").
// Ported from app-automations-templates.ts openAutomationTemplatePreview; a
// body-portal overlay (scoped module classes). The adopt/build action is
// the caller's (onUse), keeping this pure presentation.
export function openAutomationTemplatePreview(
  template: TemplateEntry,
  onUse: (t: TemplateEntry) => void,
): void {
  const integrations = template.integrations ?? [];
  const trigIcon = iconSvg(template.triggerKind === 'webhook' ? 'Webhook' : 'Clock', 14);

  const backdrop = document.createElement('div');
  backdrop.className = styles.auDrawerBackdrop ?? '';
  const panel = document.createElement('div');
  panel.className = styles.auDrawer ?? '';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', `${template.name} template`);

  const close = (): void => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  const html = (tag: string, cls: string | undefined, inner = ''): HTMLElement => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (inner) n.innerHTML = inner;
    return n;
  };
  const text = (tag: string, cls: string | undefined, t: string): HTMLElement => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    n.textContent = t;
    return n;
  };

  // Head
  const head = html('div', styles.auDrawerHead);
  head.append(text('span', styles.auDrawerEmoji, template.emoji ?? '⚙️'));
  const headText = document.createElement('div');
  headText.append(text('div', styles.auDrawerName, template.name));
  const trig = html('div', styles.auDrawerTrig);
  const trigIco = html('span', '', trigIcon);
  trigIco.setAttribute('aria-hidden', 'true');
  trig.append(trigIco, document.createTextNode(template.triggerLabel ?? 'Manual'));
  headText.append(trig);
  head.append(headText);
  const closeBtn = html('button', styles.auDrawerClose, iconSvg('X', 16));
  closeBtn.setAttribute('type', 'button');
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', close);
  head.append(closeBtn);

  // Body
  const stepsList = html('ul', styles.auDrawerSteps);
  for (const line of [
    `Fires ${template.triggerLabel ?? 'on a trigger'}.`,
    template.desc,
    integrations.length > 0
      ? `Works through ${integrations.join(', ')}.`
      : 'Runs with the workspace default tools.',
  ]) {
    stepsList.append(text('li', '', line));
  }
  const body = html('div', styles.auDrawerBody);
  body.append(text('div', styles.auDrawerSecL, 'What it does'), stepsList);
  if (integrations.length > 0) {
    body.append(text('div', styles.auDrawerSecL, 'Connects'));
    const chips = html('div', au.auChips);
    for (const name of integrations) {
      const chip = text('span', au.auChip, name);
      const hue = (INTEGRATION_HUES as Record<string, string>)[name.toLowerCase()];
      if (hue) chip.style.setProperty('--chip-hue', hue);
      chips.append(chip);
    }
    body.append(chips);
  }

  // Foot
  const useBtn = html(
    'button',
    cx(au.auBtn, au.auBtnPrimary, styles.auDrawerUse),
    `<span>Use template</span>${iconSvg('ArrowRight', 14)}`,
  );
  useBtn.setAttribute('type', 'button');
  useBtn.addEventListener('click', () => {
    close();
    onUse(template);
  });
  const foot = html('div', styles.auDrawerFoot);
  foot.append(useBtn);

  panel.append(head, body, foot);
  backdrop.append(panel);
  document.body.append(backdrop);
}
