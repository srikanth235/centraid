import { afterEach, describe, expect, it } from 'vitest';
import { openPrompt } from './prompt.js';

afterEach(() => {
  document.body.innerHTML = '';
});

const field = (): HTMLInputElement => document.querySelector('.input')!;
const button = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll('.card button')].find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement;

describe('openPrompt', () => {
  it('resolves the trimmed new value on Save', async () => {
    const p = openPrompt({ title: 'Rename app', initial: 'Todos' });
    field().value = '  Tasks  ';
    button('Save').click();
    await expect(p).resolves.toBe('Tasks');
  });

  it('resolves null when cancelled', async () => {
    const p = openPrompt({ title: 'Rename app', initial: 'Todos' });
    button('Cancel').click();
    await expect(p).resolves.toBeNull();
  });

  it('resolves null when unchanged from the initial', async () => {
    const p = openPrompt({ title: 'Rename app', initial: 'Todos' });
    field().value = 'Todos';
    button('Save').click();
    await expect(p).resolves.toBeNull();
  });

  it('resolves null when emptied', async () => {
    const p = openPrompt({ title: 'Rename app', initial: 'Todos' });
    field().value = '   ';
    button('Save').click();
    await expect(p).resolves.toBeNull();
  });

  it('commits on Enter and cancels on Escape', async () => {
    const commit = openPrompt({ title: 'Rename app', initial: 'A' });
    field().value = 'B';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await expect(commit).resolves.toBe('B');

    const cancel = openPrompt({ title: 'Rename app', initial: 'A' });
    field().value = 'B';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await expect(cancel).resolves.toBeNull();
  });
});
