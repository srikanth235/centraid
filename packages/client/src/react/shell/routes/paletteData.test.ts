import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPaletteGroups, type PaletteDeps } from './paletteData.js';

// `vi.mock` is hoisted above the import by vitest, so iconSvg's design-tokens
// dependency resolves before paletteData.js loads.
vi.mock('../iconSvg.js', () => ({ iconSvg: (name: string) => `<svg data-icon="${name}"/>` }));

beforeEach(() => {
  (globalThis as unknown as { CentraidTokens: unknown }).CentraidTokens = {
    tileFinish: () => ({ background: '#111', boxShadow: 'none', glyphColor: '#fff' }),
  };
});

function deps(over: Partial<PaletteDeps> = {}): PaletteDeps {
  return {
    userApps: [{ id: 'todos', name: 'Todos', color: 'blue', iconKey: 'Todo', desc: 'Tasks' }],
    drafts: [{ id: 'd1', name: 'Draft One', color: 'teal', iconKey: 'Sparkle', __draft: true }],
    tileVariant: 'gradient',
    navigate: vi.fn(),
    enterBuilder: vi.fn(),
    onClose: vi.fn(),
    ...over,
  } as PaletteDeps;
}

describe('buildPaletteGroups', () => {
  it('lists apps + drafts, nav targets, and a create row when the query is empty', () => {
    const groups = buildPaletteGroups('', deps());
    expect(groups.map((g) => g.group)).toEqual(['Apps', 'Go to', 'Create']);
    const apps = groups[0]!.items.map((r) => r.label);
    expect(apps).toContain('Todos');
    expect(apps).toContain('Draft One');
    expect(groups[1]!.items.map((r) => r.label)).toContain('Settings');
    expect(groups[2]!.items[0]!.label).toBe('Build a new app…');
  });

  it('filters apps + nav by the query but always keeps a create row', () => {
    const groups = buildPaletteGroups('todo', deps());
    expect(groups.find((g) => g.group === 'Apps')?.items.map((r) => r.label)).toEqual(['Todos']);
    // No nav target matches "todo", so that group is dropped.
    expect(groups.find((g) => g.group === 'Go to')).toBeUndefined();
    const create = groups.find((g) => g.group === 'Create')!.items[0]!;
    expect(create.label).toBe('Build “todo”');
  });

  it('an app row navigates to the app and closes on run', () => {
    const navigate = vi.fn();
    const onClose = vi.fn();
    const groups = buildPaletteGroups('todos', deps({ navigate, onClose }));
    groups[0]!.items[0]!.run();
    expect(onClose).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith({ kind: 'app', id: 'todos' });
  });

  it('the create row enters the builder seeded with the trimmed query', () => {
    const enterBuilder = vi.fn();
    const groups = buildPaletteGroups('  budget tracker  ', deps({ enterBuilder }));
    groups.find((g) => g.group === 'Create')!.items[0]!.run();
    expect(enterBuilder).toHaveBeenCalledWith('budget tracker');
  });
});
