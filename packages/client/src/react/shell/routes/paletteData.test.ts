import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaletteConversationSearch } from './paletteConversationSearch.js';
import { buildPaletteGroups, type PaletteDeps } from './paletteData.js';

// `vi.mock` is hoisted above the import by vitest, so iconSvg's design-tokens
// dependency resolves before paletteData.js loads.
vi.mock(import('../iconSvg.js'), () => ({
  iconSvg: (name: string) => `<svg data-icon="${name}"/>`,
}));

describe('paletteData', () => {
  beforeEach(() => {
    (globalThis as unknown as { CentraidTokens: unknown }).CentraidTokens = {
      tileFinish: () => ({ background: '#111', boxShadow: 'none', glyphColor: '#fff' }),
    };
  });

  function deps(over: Partial<PaletteDeps> = {}): PaletteDeps {
    return {
      userApps: [{ id: 'todos', name: 'Todos', color: 'blue', iconKey: 'Todo', desc: 'Tasks' }],
      drafts: [{ id: 'd1', name: 'Draft One', color: 'teal', iconKey: 'Sparkle', __draft: true }],
      builderEnabled: true,
      tileVariant: 'gradient',
      navigate: vi.fn<PaletteDeps['navigate']>(),
      enterBuilder: vi.fn<PaletteDeps['enterBuilder']>(),
      onClose: vi.fn<PaletteDeps['onClose']>(),
      ...over,
    } as PaletteDeps;
  }

  describe(buildPaletteGroups, () => {
    it('lists apps + drafts, nav targets, and a create row when the query is empty', () => {
      const groups = buildPaletteGroups('', deps());
      expect(groups.map((g) => g.group)).toStrictEqual(['Apps', 'Go to', 'Create']);
      const apps = groups[0]!.items.map((r) => r.label);
      expect(apps).toContain('Todos');
      expect(apps).toContain('Draft One');
      expect(groups[1]!.items.map((r) => r.label)).toContain('Settings');
      expect(groups[2]!.items[0]!.label).toBe('Build a new app…');
    });

    it('filters apps + nav by the query but always keeps a create row', () => {
      const groups = buildPaletteGroups('todo', deps());
      expect(groups.find((g) => g.group === 'Apps')?.items.map((r) => r.label)).toStrictEqual([
        'Todos',
      ]);
      // No nav target matches "todo", so that group is dropped.
      expect(groups.find((g) => g.group === 'Go to')).toBeUndefined();
      const create = groups.find((g) => g.group === 'Create')!.items[0]!;
      expect(create.label).toBe('Build “todo”');
    });

    it('omits the Create/build row when the builder is disabled (#434)', () => {
      // The "Build a new app…" row is a builder entry point — gone when hidden.
      const groups = buildPaletteGroups('', deps({ builderEnabled: false }));
      expect(groups.map((g) => g.group)).toStrictEqual(['Apps', 'Go to']);
      expect(groups.find((g) => g.group === 'Create')).toBeUndefined();
      // A query still never resurrects it.
      const filtered = buildPaletteGroups('budget tracker', deps({ builderEnabled: false }));
      expect(filtered.find((g) => g.group === 'Create')).toBeUndefined();
    });

    it('an app row navigates to the app and closes on run', () => {
      const navigate = vi.fn<PaletteDeps['navigate']>();
      const onClose = vi.fn<PaletteDeps['onClose']>();
      const groups = buildPaletteGroups('todos', deps({ navigate, onClose }));
      groups[0]!.items[0]!.run();
      expect(onClose).toHaveBeenCalledOnce();
      expect(navigate).toHaveBeenCalledWith({ kind: 'app', id: 'todos' });
    });

    it('the create row enters the builder seeded with the trimmed query', () => {
      const enterBuilder = vi.fn<PaletteDeps['enterBuilder']>();
      const groups = buildPaletteGroups('  budget tracker  ', deps({ enterBuilder }));
      groups.find((g) => g.group === 'Create')!.items[0]!.run();
      expect(enterBuilder).toHaveBeenCalledWith('budget tracker');
    });

    it('adds a Conversations group from the search source and deep-links on run (#420)', () => {
      const navigate = vi.fn<PaletteDeps['navigate']>();
      const onClose = vi.fn<PaletteDeps['onClose']>();
      const ensure = vi.fn<PaletteConversationSearch['ensure']>();
      const conversationSearch = {
        ensure,
        results: () => [{ id: 'c9', title: 'Budget chat', snippet: 'the ⟦budget⟧ plan' }],
        reset: vi.fn<PaletteConversationSearch['reset']>(),
        setOnResults: vi.fn<PaletteConversationSearch['setOnResults']>(),
      };
      const groups = buildPaletteGroups('budget', deps({ navigate, onClose, conversationSearch }));
      expect(ensure).toHaveBeenCalledWith('budget');
      const convo = groups.find((g) => g.group === 'Conversations')!;
      expect(convo.items[0]!.label).toBe('Budget chat');
      // Snippet markers are stripped for the plain sub text.
      expect(convo.items[0]!.sub).toBe('the budget plan');
      convo.items[0]!.run();
      expect(onClose).toHaveBeenCalledOnce();
      expect(navigate).toHaveBeenCalledWith({ kind: 'assistant', conversationId: 'c9' });
    });

    it('omits the Conversations group with no query or no hits (#420)', () => {
      const empty = {
        ensure: vi.fn<PaletteConversationSearch['ensure']>(),
        results: () => [],
        reset: vi.fn<PaletteConversationSearch['reset']>(),
        setOnResults: vi.fn<PaletteConversationSearch['setOnResults']>(),
      };
      expect(
        buildPaletteGroups('', deps({ conversationSearch: empty })).find(
          (g) => g.group === 'Conversations',
        ),
      ).toBeUndefined();
      expect(
        buildPaletteGroups('budget', deps({ conversationSearch: empty })).find(
          (g) => g.group === 'Conversations',
        ),
      ).toBeUndefined();
    });
  });
});
