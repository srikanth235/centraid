/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
/**
 * Direct unit test naming run-automation.ts (issue #545 B11).
 * Mocks the automation fire spine so we assert openDispatch wiring without a full fire.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const runFire = vi.fn();
const startLiveDispatch = vi.fn(() => ({
  agent: async () => ({ text: 'ok' }),
  close: async () => undefined,
}));

vi.mock('@centraid/automation', () => ({
  runFire: (...args: unknown[]) => runFire(...args),
}));

vi.mock('./run-automation-live-dispatch.js', () => ({
  startLiveDispatch: (...args: never[]) =>
    (startLiveDispatch as (...a: never[]) => ReturnType<typeof startLiveDispatch>)(...args),
}));

import { runAutomation } from './run-automation.ts';

beforeEach(() => {
  runFire.mockReset();
  startLiveDispatch.mockClear();
  runFire.mockResolvedValue({
    outcome: { ok: true, value: { summary: 'done' } },
    record: { runId: 'r1', automationId: 'app/a', ok: true },
  });
});

describe('runAutomation', () => {
  it('forwards fire options and injects openDispatch that captures runner kind', async () => {
    const result = await runAutomation({
      automationRef: 'app/digest',
      appsDir: '/apps',
      journalDbFile: '/j.db',
      runner: 'claude-code',
      model: 'm1',
      runId: 'run-1',
      triggerKind: 'scheduled',
      input: { x: 1 },
    });

    expect(result.outcome.ok).toBe(true);
    expect(runFire).toHaveBeenCalledTimes(1);
    const [fireOpts, deps] = runFire.mock.calls[0] as [
      Record<string, unknown>,
      {
        openDispatch: (a: {
          workdir: string;
          runId: string;
          model?: string;
          onLog?: unknown;
        }) => unknown;
      },
    ];
    expect(fireOpts).toMatchObject({
      automationRef: 'app/digest',
      appsDir: '/apps',
      journalDbFile: '/j.db',
      runId: 'run-1',
      triggerKind: 'scheduled',
      input: { x: 1 },
    });

    deps.openDispatch({ workdir: '/w', runId: 'run-1', model: 'from-manifest' });
    expect(startLiveDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workdir: '/w',
        runId: 'run-1',
        runner: 'claude-code',
        model: 'from-manifest',
      }),
    );

    // Fallback to opts.model when manifest does not name one.
    deps.openDispatch({ workdir: '/w', runId: 'run-1' });
    expect(startLiveDispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: 'm1', runner: 'claude-code' }),
    );
  });

  it('defaults runner to codex when omitted', async () => {
    await runAutomation({
      automationRef: 'app/a',
      appsDir: '/apps',
      journalDbFile: '/j.db',
    });
    const deps = runFire.mock.calls[0]![1] as {
      openDispatch: (a: { workdir: string; runId: string }) => unknown;
    };
    deps.openDispatch({ workdir: '/w', runId: 'r' });
    expect(startLiveDispatch).toHaveBeenCalledWith(expect.objectContaining({ runner: 'codex' }));
  });
});
