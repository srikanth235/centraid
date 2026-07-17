import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TemplateEntry } from '../../app-shell-context.js';
import { describeScopes, openTemplatePreview } from './templatePreview.js';

const tmpl = {
  id: 'todos',
  name: 'Todos',
  desc: 'A small todo app',
  colorKey: 'blue',
  iconKey: 'Todo',
  version: '1.0',
} as unknown as TemplateEntry;

const tmplWithVault = {
  ...tmpl,
  vault: {
    purpose: 'dpv:ServiceProvision',
    why: 'Keeps your task list and lets you check things off.',
    scopes: [
      { schema: 'core', table: 'content_item', verbs: 'read' },
      { schema: 'core', table: 'tag', verbs: 'read' },
      { schema: 'tasks', table: 'add_task', verbs: 'act' },
      { schema: 'tasks', table: 'complete_task', verbs: 'act' },
    ],
  },
} as unknown as TemplateEntry;

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('describeScopes', () => {
  it('groups scopes by verb into read/act clauses with relaxed nouns', () => {
    const groups = describeScopes(tmplWithVault.vault!.scopes);
    expect(groups.map((g) => g.verb)).toEqual(['read', 'act']);
    const read = groups.find((g) => g.verb === 'read')!;
    expect(read.label).toBe('Read');
    expect(read.items).toEqual(['content item', 'tag']);
    const act = groups.find((g) => g.verb === 'act')!;
    expect(act.label).toBe('Add & change');
    expect(act.items).toEqual(['add task', 'complete task']);
  });

  it('splits a compound verb into separate groups', () => {
    const groups = describeScopes([{ schema: 'media', verbs: 'read+act' }]);
    expect(groups.map((g) => g.verb)).toEqual(['read', 'act']);
    expect(groups[0]!.items).toEqual(['media']);
  });
});

describe('openTemplatePreview (install/consent sheet)', () => {
  it('mounts an install sheet with the app identity + version', () => {
    openTemplatePreview(tmpl, () => {});
    const card = document.querySelector('.tmplPreview')!;
    expect(card.textContent).toContain('Todos');
    expect(card.textContent).toContain('A small todo app');
    expect(card.textContent).toContain('App · v1.0');
  });

  it('renders the consent surface — why line + scope sentences — from the vault block', () => {
    openTemplatePreview(tmplWithVault, () => {});
    const card = document.querySelector('.tmplPreview')!;
    expect(card.textContent).toContain('What Todos can access');
    expect(card.textContent).toContain('Keeps your task list and lets you check things off.');
    // Grouped, humanized — not raw JSON.
    expect(card.textContent).toContain('Read');
    expect(card.textContent).toContain('content item, tag');
    expect(card.textContent).toContain('Add & change');
    expect(card.textContent).toContain('add task, complete task');
    expect(card.textContent).not.toContain('"schema"');
  });

  it('notes when an app requests no vault access', () => {
    openTemplatePreview(tmpl, () => {});
    const card = document.querySelector('.tmplPreview')!;
    expect(card.textContent).toContain('This app requests no access to your vault.');
  });

  it('fires onInstall with the template and closes when "Install" is clicked', () => {
    const onInstall = vi.fn();
    openTemplatePreview(tmpl, onInstall);
    const installBtn = [...document.querySelectorAll('.primary')].find((b) =>
      b.textContent?.includes('Install'),
    ) as HTMLButtonElement;
    installBtn.click();
    expect(onInstall).toHaveBeenCalledWith(tmpl);
    expect(document.querySelector('.tmplPreview')).toBeNull();
  });

  it('closes on Cancel, backdrop click, and Escape without firing onInstall', () => {
    const onInstall = vi.fn();
    openTemplatePreview(tmpl, onInstall);
    (document.querySelector('.ghost') as HTMLButtonElement).click();
    expect(document.querySelector('.tmplPreview')).toBeNull();

    openTemplatePreview(tmpl, onInstall);
    (document.querySelector('.backdrop') as HTMLElement).click();
    expect(document.querySelector('.tmplPreview')).toBeNull();

    openTemplatePreview(tmpl, onInstall);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.tmplPreview')).toBeNull();
    expect(onInstall).not.toHaveBeenCalled();
  });
});
