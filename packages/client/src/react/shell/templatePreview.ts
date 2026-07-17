import { palette } from '@centraid/design-tokens';
import type { TemplateEntry, TemplateVaultBlock } from '../../app-shell-context.js';
import { iconSvg } from './iconSvg.js';
import buttonCss from '../ui/Button.module.css';
import styles from './templatePreview.module.css';
import { cx } from '../ui/cx.js';
import modalCss from '../styles/modal.module.css';

// App install sheet (issue #434) — the consent surface. Shows an app's
// identity + blurb and, rendered straight from its `app.json` `vault` block,
// exactly what it will be able to touch. The Install button IS the consent
// act: tapping it registers the app + grants the declared scopes (no code is
// copied — bundled apps serve in place and upgrade with every release). A
// body-portal overlay so it's callable from any route; the install action is
// the caller's (onInstall), keeping this pure presentation.

/** A verb group in the access summary — one owner-facing sentence. */
interface AccessGroup {
  verb: string;
  label: string;
  items: string[];
}

/** Human name for one requested scope: its table (or schema when table-wide),
 *  with underscores relaxed into words ("content_item" → "content item"). */
function scopeNoun(scope: TemplateVaultBlock['scopes'][number]): string {
  return (scope.table ?? scope.schema).replace(/_/g, ' ');
}

// Verb code → owner-facing lead. Apps declare `read` (projection) and `act`
// (typed commands that mutate). Anything else falls back to the raw verb so a
// new verb never renders blank.
const VERB_LABEL: Record<string, string> = { read: 'Read', act: 'Add & change' };

/**
 * Turn the raw `vault.scopes` into a short list of owner-facing sentences,
 * grouped by verb ("Read your media, tags, albums…"; "Add & change: add
 * asset, create album…"). Distinct nouns per group, capped so the sheet
 * stays skimmable — the full grant is always visible later in App info.
 */
export function describeScopes(scopes: TemplateVaultBlock['scopes']): AccessGroup[] {
  const byVerb = new Map<string, string[]>();
  for (const scope of scopes) {
    // A scope's `verbs` can be a compound like "read+act" — split so each
    // verb lands in its own group.
    for (const verb of scope.verbs
      .split('+')
      .map((v) => v.trim())
      .filter(Boolean)) {
      const noun = scopeNoun(scope);
      const list = byVerb.get(verb) ?? [];
      if (!list.includes(noun)) list.push(noun);
      byVerb.set(verb, list);
    }
  }
  const order = ['read', 'act'];
  return [...byVerb.keys()]
    .sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
    })
    .map((verb) => ({
      verb,
      label: VERB_LABEL[verb] ?? verb.charAt(0).toUpperCase() + verb.slice(1),
      items: byVerb.get(verb) ?? [],
    }));
}

/** Join nouns into one clause, capping the tail with "+N more". */
function joinNouns(items: string[], cap = 7): string {
  if (items.length <= cap) return items.join(', ');
  return `${items.slice(0, cap).join(', ')}, +${items.length - cap} more`;
}

function buildAccessSection(vault: TemplateVaultBlock | undefined, appName: string): HTMLElement {
  const box = document.createElement('div');
  box.className = styles.tmplAccess ?? '';
  const label = document.createElement('div');
  label.className = styles.tmplAccessLabel ?? '';
  label.textContent = `What ${appName} can access`;
  box.append(label);

  const groups = vault ? describeScopes(vault.scopes) : [];
  if (groups.length === 0) {
    const none = document.createElement('div');
    none.className = styles.tmplAccessWhy ?? '';
    none.textContent = 'This app requests no access to your vault.';
    box.append(none);
    return box;
  }

  if (vault?.why) {
    const why = document.createElement('div');
    why.className = styles.tmplAccessWhy ?? '';
    why.textContent = vault.why;
    box.append(why);
  }
  for (const group of groups) {
    const row = document.createElement('div');
    row.className = styles.tmplAccessRow ?? '';
    const verb = document.createElement('span');
    verb.className = styles.tmplAccessVerb ?? '';
    verb.textContent = group.label;
    const items = document.createElement('span');
    items.className = styles.tmplAccessItems ?? '';
    items.textContent = joinNouns(group.items);
    row.append(verb, items);
    box.append(row);
  }
  return box;
}

export function openTemplatePreview(
  tmpl: TemplateEntry,
  onInstall: (t: TemplateEntry) => void,
): void {
  const color = (palette as unknown as Record<string, string>)[tmpl.colorKey] || '#7C5BD9';

  const backdrop = document.createElement('div');
  backdrop.className = modalCss.backdrop ?? '';
  const card = document.createElement('div');
  card.className = cx(modalCss.card, styles.tmplPreview);
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', `Install ${tmpl.name}`);

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
  eyebrow.textContent = `App · v${tmpl.version}`;
  const h3 = document.createElement('h3');
  h3.textContent = tmpl.name;
  headText.append(eyebrow, h3);
  head.append(headText);
  card.append(head);

  const desc = document.createElement('p');
  desc.textContent = tmpl.desc;
  card.append(desc);

  card.append(buildAccessSection(tmpl.vault, tmpl.name));

  const note = document.createElement('div');
  note.className = styles.tmplPreviewNote ?? '';
  note.textContent =
    'Installing grants the access above. Nothing is copied — the app runs from the shipped release and updates with it. Uninstall anytime; your data stays in your vault.';
  card.append(note);

  const cancel = document.createElement('button');
  cancel.className = cx(buttonCss.btn, buttonCss.ghost);
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', close);
  const installBtn = document.createElement('button');
  installBtn.className = cx(buttonCss.btn, buttonCss.primary);
  installBtn.innerHTML = `${iconSvg('Plus', 13)}<span>Install</span>`;
  installBtn.addEventListener('click', () => {
    close();
    onInstall(tmpl);
  });
  const actions = document.createElement('div');
  actions.className = modalCss.actions ?? '';
  actions.append(cancel, installBtn);
  card.append(actions);

  document.body.append(backdrop, card);
  setTimeout(() => installBtn.focus(), 30);
}
