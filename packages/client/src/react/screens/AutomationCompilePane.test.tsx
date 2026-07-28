import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CompileAttemptDTO, CompileStepDTO } from '../screen-contracts.js';
import AutomationCompilePane, { type AutomationCompilePaneProps } from './AutomationCompilePane.js';

// The compile loop, which is the half of the automations UX the run screen is
// no longer allowed to touch: compile in place, watch the steps, read the
// failure, test the plan. The rail READS — it offers no way to type, because
// the instructions field in the left column is the only editable surface.

const failedAttempt: CompileAttemptDTO = {
  turnId: 'c-1',
  startedAt: 1000,
  endedAt: 2000,
  status: 'fail',
  error: 'handler.js: unexpected token',
  summary: null,
  whenLabel: '2m ago',
};
const okAttempt: CompileAttemptDTO = {
  turnId: 'c-2',
  startedAt: 3000,
  endedAt: 4000,
  status: 'ok',
  error: null,
  summary: 'compiled',
  whenLabel: 'just now',
};
const steps: CompileStepDTO[] = [
  {
    itemId: 'i1',
    ordinal: 0,
    kind: 'tool',
    label: 'write_file',
    status: 'ok',
    durationMs: 120,
    detail: 'handler.js',
  },
  {
    itemId: 'i2',
    ordinal: 1,
    kind: 'tool',
    label: 'typecheck',
    status: 'fail',
    durationMs: 900,
    detail: 'unexpected token',
  },
];

function makeProps(over: Partial<AutomationCompilePaneProps> = {}): AutomationCompilePaneProps {
  return {
    mode: 'edit',
    dirty: false,
    compileNonce: 0,
    onCompile: vi.fn<AutomationCompilePaneProps['onCompile']>().mockResolvedValue('c-3'),
    onTestRun: vi.fn<AutomationCompilePaneProps['onTestRun']>().mockResolvedValue('t-1'),
    onEditInstructions: vi.fn<AutomationCompilePaneProps['onEditInstructions']>(),
    loadAttempts: vi.fn<AutomationCompilePaneProps['loadAttempts']>().mockResolvedValue([]),
    loadTurnSteps: vi.fn<AutomationCompilePaneProps['loadTurnSteps']>().mockResolvedValue([]),
    watchTurnSteps: vi
      .fn<AutomationCompilePaneProps['watchTurnSteps']>()
      .mockResolvedValue({ settled: true, ok: true }),
    onReadSource: vi
      .fn<AutomationCompilePaneProps['onReadSource']>()
      .mockResolvedValue({ handler: null, manifest: null }),
    onOpenRun: vi.fn<AutomationCompilePaneProps['onOpenRun']>(),
    onOpenRuns: vi.fn<AutomationCompilePaneProps['onOpenRuns']>(),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
describe('screens/AutomationCompilePane', () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  async function mount(props: AutomationCompilePaneProps): Promise<HTMLDivElement> {
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(<AutomationCompilePane {...props} />);
    });
    return container;
  }

  function click(el: HTMLElement, testId: string): Promise<void> {
    const target = el.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (!target) throw new Error(`no [data-testid="${testId}"]`);
    return act(async () => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  function verdict(el: HTMLElement): string {
    return el.querySelector('[data-testid="compile-verdict"]')?.textContent ?? '';
  }

  describe(AutomationCompilePane, () => {
    it('shows the last failed compile with its steps and the failure text', async () => {
      const el = await mount(
        makeProps({
          loadAttempts: vi
            .fn<AutomationCompilePaneProps['loadAttempts']>()
            .mockResolvedValue([failedAttempt]),
          loadTurnSteps: vi
            .fn<AutomationCompilePaneProps['loadTurnSteps']>()
            .mockResolvedValue(steps),
        }),
      );
      expect(verdict(el)).toBe('Compile failed');
      expect(el.textContent).toContain('handler.js: unexpected token');
      const rows = [...el.querySelectorAll('[data-testid="compile-step"]')];
      expect(rows.map((r) => (r as HTMLElement).dataset.status)).toStrictEqual(['ok', 'fail']);
      expect(rows[1]?.textContent).toContain('typecheck');
    });

    it('compiles in place — it never navigates, and streams the new attempt', async () => {
      const onCompile = vi.fn<AutomationCompilePaneProps['onCompile']>().mockResolvedValue('c-3');
      const watchTurnSteps = vi.fn<AutomationCompilePaneProps['watchTurnSteps']>(
        async (_id, onSteps) => {
          onSteps(steps);
          return { settled: true, ok: false };
        },
      );
      const el = await mount(
        makeProps({
          onCompile,
          watchTurnSteps,
          loadAttempts: vi
            .fn<AutomationCompilePaneProps['loadAttempts']>()
            .mockResolvedValue([okAttempt]),
        }),
      );
      await click(el, 'compile-now');
      expect(onCompile).toHaveBeenCalledWith();
      expect(watchTurnSteps).toHaveBeenCalledWith(
        'c-3',
        expect.any(Function),
        expect.any(AbortSignal),
      );
      expect(el.querySelectorAll('[data-testid="compile-step"]')).toHaveLength(2);
    });

    it('falls back to a cold read when the compile stream drops mid-turn', async () => {
      const loadTurnSteps = vi
        .fn<AutomationCompilePaneProps['loadTurnSteps']>()
        .mockResolvedValue(steps);
      const el = await mount(
        makeProps({
          loadAttempts: vi.fn<AutomationCompilePaneProps['loadAttempts']>().mockResolvedValue([]),
          loadTurnSteps,
          // settled:false — the stream closed with the turn still open. Leaving
          // the rail spinning would be the dishonest option.
          watchTurnSteps: vi
            .fn<AutomationCompilePaneProps['watchTurnSteps']>()
            .mockResolvedValue({ settled: false, ok: false }),
        }),
      );
      await click(el, 'compile-now');
      expect(loadTurnSteps).toHaveBeenCalledWith('c-3');
      expect(el.querySelectorAll('[data-testid="compile-step"]')).toHaveLength(2);
    });

    it('hands a failure back to the instructions instead of offering a second editor', async () => {
      const onEditInstructions = vi.fn<AutomationCompilePaneProps['onEditInstructions']>();
      const el = await mount(
        makeProps({
          onEditInstructions,
          loadAttempts: vi
            .fn<AutomationCompilePaneProps['loadAttempts']>()
            .mockResolvedValue([failedAttempt]),
        }),
      );
      // The raw compiler text survives verbatim...
      expect(el.querySelector('[data-testid="compile-failure"]')?.textContent).toContain(
        'handler.js: unexpected token',
      );
      // ...and the only cure on offer points back at the one authored field.
      await click(el, 'compile-edit-instructions');
      expect(onEditInstructions).toHaveBeenCalledWith(expect.objectContaining({ type: 'click' }));
      expect(el.querySelector('input')).toBeNull();
      expect(el.querySelector('textarea')).toBeNull();
      expect(el.querySelector('form')).toBeNull();
    });

    it('gates Test run behind a successful compile', async () => {
      const failing = await mount(
        makeProps({
          loadAttempts: vi
            .fn<AutomationCompilePaneProps['loadAttempts']>()
            .mockResolvedValue([failedAttempt]),
        }),
      );
      expect(
        failing.querySelector<HTMLButtonElement>('[data-testid="compile-test-run"]')?.disabled,
      ).toBe(true);

      act(() => root?.unmount());
      container?.remove();

      const onTestRun = vi.fn<AutomationCompilePaneProps['onTestRun']>().mockResolvedValue('t-1');
      const passing = await mount(
        makeProps({
          onTestRun,
          loadAttempts: vi
            .fn<AutomationCompilePaneProps['loadAttempts']>()
            .mockResolvedValue([okAttempt]),
        }),
      );
      expect(
        passing.querySelector<HTMLButtonElement>('[data-testid="compile-test-run"]')?.disabled,
      ).toBe(false);
      await click(passing, 'compile-test-run');
      expect(onTestRun).toHaveBeenCalledWith();
    });

    it('calls a stale plan stale when the instructions moved on', async () => {
      const el = await mount(
        makeProps({
          dirty: true,
          loadAttempts: vi
            .fn<AutomationCompilePaneProps['loadAttempts']>()
            .mockResolvedValue([okAttempt]),
        }),
      );
      expect(verdict(el)).toBe('Plan is stale');
    });

    it('offers no compile controls in create mode', async () => {
      const el = await mount(makeProps({ mode: 'create' }));
      expect(verdict(el)).toBe('Not compiled');
      expect(el.querySelector('[data-testid="compile-now"]')).toBeNull();
      expect(el.querySelector('[data-testid="compile-test-run"]')).toBeNull();
    });

    it('counts up while a compile is open, and shows no clock once it settles', async () => {
      // A compile is a coding-agent run and can take minutes; without a clock,
      // "Compiling…" is indistinguishable from a hang.
      vi.useFakeTimers();
      vi.setSystemTime(60_000);
      try {
        const running: CompileAttemptDTO = {
          turnId: 'c-9',
          startedAt: 60_000 - 95_000, // opened 1m35s ago
          endedAt: null,
          status: 'running',
          error: null,
          summary: null,
          whenLabel: 'just now',
        };
        const el = await mount(
          makeProps({
            loadAttempts: vi
              .fn<AutomationCompilePaneProps['loadAttempts']>()
              .mockResolvedValue([running]),
          }),
        );
        expect(verdict(el)).toBe('Compiling…');
        expect(el.querySelector('[data-testid="compile-elapsed"]')?.textContent).toBe('1:35');
        // A compile this mount did not start still counts as busy — otherwise
        // reloading mid-compile offers a button that starts a second one.
        const compileBtn = el.querySelector<HTMLButtonElement>('[data-testid="compile-now"]');
        expect(compileBtn?.disabled).toBe(true);
        expect(compileBtn?.textContent).toContain('Compiling…');
        expect(el.textContent).toContain('Waiting for the first step…');

        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });
        expect(el.querySelector('[data-testid="compile-elapsed"]')?.textContent).toBe('1:40');
      } finally {
        vi.useRealTimers();
      }
    });

    it('shows no elapsed clock when nothing is running', async () => {
      const el = await mount(
        makeProps({
          loadAttempts: vi
            .fn<AutomationCompilePaneProps['loadAttempts']>()
            .mockResolvedValue([okAttempt]),
        }),
      );
      expect(verdict(el)).toBe('Plan ready');
      expect(el.querySelector('[data-testid="compile-elapsed"]')).toBeNull();
    });

    it('compiles when the editor bumps the nonce, and not on the initial render', async () => {
      const onCompile = vi.fn<AutomationCompilePaneProps['onCompile']>().mockResolvedValue('c-3');
      const props = makeProps({ onCompile });
      const el = await mount(props);
      expect(onCompile).not.toHaveBeenCalled();
      await act(async () => {
        root?.render(<AutomationCompilePane {...props} compileNonce={1} />);
      });
      expect(onCompile).toHaveBeenCalledOnce();
      expect(el.querySelector('[data-testid="automation-compile-pane"]')).not.toBeNull();
    });
  });
});
