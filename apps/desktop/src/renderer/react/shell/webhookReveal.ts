import { iconSvg } from './iconSvg.js';
import styles from './webhookReveal.module.css';
import modalCss from '../styles/modal.module.css';
import buttonCss from '../ui/Button.module.css';
import { cx } from '../ui/cx.js';

// One-time webhook-secret reveal — a body-portal overlay (same imperative-DOM
// shape as `confirm.ts` / `automationTemplatePreview.ts`) shown right after a
// webhook secret is minted (template adopt / scaffold) or rotated
// (regenerate). Only the SHA-256 hash is ever persisted server-side, so this
// modal is the one and only in-app chance to read the plaintext secret —
// replaces the old DevTools-only `console.info` reveal (kept as a dev
// fallback by the caller). Pure presentation: copy-to-clipboard is the only
// side effect: the caller is done once the mint/rotate call already
// succeeded.

export interface MintedWebhook {
  url: string;
  secret: string;
}
export interface WebhookRevealOpts {
  title?: string;
  note?: string;
}

function copyButton(getValue: () => string, label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = cx(buttonCss.icon, styles.copyBtn);
  btn.setAttribute('aria-label', `Copy ${label}`);
  btn.title = `Copy ${label}`;
  btn.innerHTML = iconSvg('Copy', 14);
  btn.addEventListener('click', () => {
    void navigator.clipboard
      .writeText(getValue())
      .then(() => {
        btn.innerHTML = iconSvg('Check', 14);
        setTimeout(() => {
          btn.innerHTML = iconSvg('Copy', 14);
        }, 1200);
      })
      .catch(() => {
        // Clipboard access can be denied (permissions/headless); the field
        // itself is selectable text, so the user still has a fallback.
      });
  });
  return btn;
}

/**
 * Show a freshly-minted or rotated webhook secret exactly once. Resolves
 * when the user closes the modal (Done / X / Esc / backdrop click) — there
 * is nothing to confirm, so it always resolves, never rejects.
 */
export function openWebhookReveal(
  webhook: MintedWebhook,
  opts: WebhookRevealOpts = {},
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      card.remove();
      resolve();
    };

    const backdrop = document.createElement('div');
    backdrop.className = modalCss.backdrop ?? '';
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish();
    });

    const title = opts.title ?? 'Webhook minted';
    const card = document.createElement('div');
    card.className = modalCss.card ?? '';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', title);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = cx(buttonCss.icon, modalCss.close);
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = iconSvg('X', 16);
    closeBtn.addEventListener('click', finish);

    const heading = document.createElement('h3');
    heading.textContent = title;
    const body = document.createElement('p');
    body.textContent =
      opts.note ?? "This secret is shown once. Copy it now — you won't see it again.";

    const urlField = document.createElement('div');
    urlField.className = styles.field ?? '';
    const urlLabel = document.createElement('div');
    urlLabel.className = styles.fieldLabel ?? '';
    urlLabel.textContent = 'Webhook URL';
    const urlRow = document.createElement('div');
    urlRow.className = styles.fieldRow ?? '';
    const urlCode = document.createElement('code');
    urlCode.className = styles.fieldValue ?? '';
    urlCode.textContent = webhook.url;
    urlRow.append(
      urlCode,
      copyButton(() => webhook.url, 'webhook URL'),
    );
    urlField.append(urlLabel, urlRow);

    const secretField = document.createElement('div');
    secretField.className = styles.field ?? '';
    const secretLabel = document.createElement('div');
    secretLabel.className = styles.fieldLabel ?? '';
    secretLabel.textContent = 'Bearer secret';
    const secretRow = document.createElement('div');
    secretRow.className = styles.fieldRow ?? '';
    const secretCode = document.createElement('code');
    secretCode.className = styles.fieldValue ?? '';
    secretCode.textContent = webhook.secret;
    secretRow.append(
      secretCode,
      copyButton(() => webhook.secret, 'bearer secret'),
    );
    secretField.append(secretLabel, secretRow);

    const warn = document.createElement('div');
    warn.className = styles.warn ?? '';
    warn.innerHTML = iconSvg('AlertTriangle', 13);
    warn.append(
      document.createTextNode(" Only its hash is stored — this is the only time it's readable."),
    );

    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = cx(buttonCss.btn, buttonCss.primary);
    doneBtn.textContent = 'Done';
    doneBtn.addEventListener('click', finish);

    const actions = document.createElement('div');
    actions.className = modalCss.actions ?? '';
    actions.append(doneBtn);

    card.append(closeBtn, heading, body, urlField, secretField, warn, actions);

    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish();
      }
    }
    document.addEventListener('keydown', onKey);

    document.body.append(backdrop, card);
    setTimeout(() => doneBtn.focus(), 30);
  });
}
