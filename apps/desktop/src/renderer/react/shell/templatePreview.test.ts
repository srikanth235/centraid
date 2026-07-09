import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TemplateEntry } from '../../app-shell-context.js';
import { openTemplatePreview } from './templatePreview.js';

const tmpl = {
  id: 'todos',
  name: 'Todos',
  desc: 'A small todo app',
  colorKey: 'blue',
  iconKey: 'Todo',
  version: '1.0',
} as unknown as TemplateEntry;

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('openTemplatePreview', () => {
  it('mounts a preview modal with the template identity + version', () => {
    openTemplatePreview(tmpl, () => {});
    const card = document.querySelector('.cd-tmpl-preview')!;
    expect(card.textContent).toContain('Todos');
    expect(card.textContent).toContain('A small todo app');
    expect(card.textContent).toContain('Template · v1.0');
  });

  it('fires onUse with the template and closes when "Use" is clicked', () => {
    const onUse = vi.fn();
    openTemplatePreview(tmpl, onUse);
    const useBtn = [...document.querySelectorAll('.btn-primary')].find((b) =>
      b.textContent?.includes('Use this template'),
    ) as HTMLButtonElement;
    useBtn.click();
    expect(onUse).toHaveBeenCalledWith(tmpl);
    expect(document.querySelector('.cd-tmpl-preview')).toBeNull();
  });

  it('closes on Cancel, backdrop click, and Escape without firing onUse', () => {
    const onUse = vi.fn();
    openTemplatePreview(tmpl, onUse);
    (document.querySelector('.btn-ghost') as HTMLButtonElement).click();
    expect(document.querySelector('.cd-tmpl-preview')).toBeNull();

    openTemplatePreview(tmpl, onUse);
    (document.querySelector('.modal-backdrop') as HTMLElement).click();
    expect(document.querySelector('.cd-tmpl-preview')).toBeNull();

    openTemplatePreview(tmpl, onUse);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.cd-tmpl-preview')).toBeNull();
    expect(onUse).not.toHaveBeenCalled();
  });
});
