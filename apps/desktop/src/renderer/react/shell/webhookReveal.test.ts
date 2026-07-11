import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openWebhookReveal } from './webhookReveal.js';

beforeEach(() => {
  document.body.innerHTML = '';
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});
afterEach(() => {
  document.body.innerHTML = '';
});

const WEBHOOK = { url: 'https://gw.example/_centraid-hook/abc123', secret: 'shh-once-only' };

describe('openWebhookReveal', () => {
  it('mounts the URL + secret and resolves on Done', async () => {
    const p = openWebhookReveal(WEBHOOK);
    const card = document.querySelector('.card')!;
    expect(card.textContent).toContain(WEBHOOK.url);
    expect(card.textContent).toContain(WEBHOOK.secret);
    expect(card.textContent).toContain("won't see it again");
    (
      [...card.querySelectorAll('button')].find((b) => b.textContent === 'Done') as HTMLButtonElement
    ).click();
    await p;
    expect(document.querySelector('.card')).toBeNull();
  });

  it('uses a custom title + note when given', async () => {
    const p = openWebhookReveal(WEBHOOK, { title: 'New secret', note: 'Update your caller.' });
    const card = document.querySelector('.card')!;
    expect(card.textContent).toContain('New secret');
    expect(card.textContent).toContain('Update your caller.');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await p;
  });

  it('copies the URL and secret to the clipboard via their copy buttons', async () => {
    const p = openWebhookReveal(WEBHOOK);
    const [copyUrlBtn, copySecretBtn] = [
      ...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Copy "]'),
    ];
    copyUrlBtn?.click();
    copySecretBtn?.click();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(WEBHOOK.url);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(WEBHOOK.secret);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await p;
  });

  it('resolves on backdrop click and on Escape', async () => {
    const p1 = openWebhookReveal(WEBHOOK);
    (document.querySelector('.backdrop') as HTMLElement).click();
    await p1;
    expect(document.querySelector('.card')).toBeNull();

    const p2 = openWebhookReveal(WEBHOOK);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await p2;
    expect(document.querySelector('.card')).toBeNull();
  });
});
