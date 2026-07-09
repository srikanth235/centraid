import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openConfirm } from './confirm.js';

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('openConfirm', () => {
  it('mounts a dialog with the title/message and resolves true on Confirm', async () => {
    const p = openConfirm({ title: 'Delete?', message: 'Are you sure', confirmLabel: 'Delete' });
    const card = document.querySelector('.card')!;
    expect(card.textContent).toContain('Delete?');
    expect(card.textContent).toContain('Are you sure');
    (card.querySelector('.danger, .btn-primary') as HTMLButtonElement).click();
    expect(await p).toBe(true);
    expect(document.querySelector('.card')).toBeNull();
  });

  it('resolves false on Cancel and on backdrop click', async () => {
    const p1 = openConfirm({ title: 'T', message: 'M' });
    (document.querySelector('.btn-ghost') as HTMLButtonElement).click();
    expect(await p1).toBe(false);

    const p2 = openConfirm({ title: 'T', message: 'M' });
    (document.querySelector('.backdrop') as HTMLElement).click();
    expect(await p2).toBe(false);
  });

  it('uses the danger button style when danger is set', () => {
    void openConfirm({ title: 'T', message: 'M', danger: true });
    expect(document.querySelector('.danger')).not.toBeNull();
  });

  it('Enter confirms and Escape cancels', async () => {
    const p1 = openConfirm({ title: 'T', message: 'M' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(await p1).toBe(true);

    const p2 = openConfirm({ title: 'T', message: 'M' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await p2).toBe(false);
  });
});
