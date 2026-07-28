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
  parseAutomationAgentFailure: (error: string | undefined) => {
    const prefix = 'centraid-agent-failure:';
    if (!error?.startsWith(prefix)) return undefined;
    return JSON.parse(error.slice(prefix.length));
  },
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

  it('re-enters a failed automation on the next ladder rung as a new ledger turn', async () => {
    const failure =
      'centraid-agent-failure:{"runner":"codex","failureClass":"quota","message":"limit"}';
    runFire
      .mockResolvedValueOnce({
        outcome: { ok: false, error: failure },
        record: { runId: 'run-fire', ok: false },
      })
      .mockResolvedValueOnce({
        outcome: { ok: true, value: 'done' },
        record: { runId: 'run-fire:failover:1:claude-code', ok: true },
      });
    const onFailover = vi.fn();

    const result = await runAutomation({
      automationRef: 'app/digest',
      appsDir: '/apps',
      journalDbFile: '/j.db',
      runId: 'run-fire',
      runner: 'codex',
      runnerLadder: ['codex', 'claude-code'],
      onFailover,
    });

    expect(result.outcome.ok).toBe(true);
    expect(runFire).toHaveBeenCalledTimes(2);
    expect(runFire.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ runId: 'run-fire', runnerKind: 'codex' }),
      expect.objectContaining({
        runId: 'run-fire:failover:1:claude-code',
        runnerKind: 'claude-code',
        note:
          'codex failed at the automation fire boundary (quota). ' +
          'Continuing with claude-code; provider-specific model and effort pins were cleared.',
        failoverNotice:
          'codex failed at the automation fire boundary (quota). ' +
          'Continuing with claude-code; provider-specific model and effort pins were cleared.',
      }),
    ]);
    expect(onFailover).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'codex', to: 'claude-code' }),
    );
  });

  it('keeps the caller trigger note alongside the failover notice', async () => {
    const failure =
      'centraid-agent-failure:{"runner":"codex","failureClass":"quota","message":"limit"}';
    runFire
      .mockResolvedValueOnce({
        outcome: { ok: false, error: failure },
        record: { runId: 'run-fire', ok: false },
      })
      .mockResolvedValueOnce({
        outcome: { ok: true, value: 'done' },
        record: { runId: 'run-fire:failover:1:claude-code', ok: true },
      });

    await runAutomation({
      automationRef: 'app/digest',
      appsDir: '/apps',
      journalDbFile: '/j.db',
      runId: 'run-fire',
      runner: 'codex',
      runnerLadder: ['codex', 'claude-code'],
      note: 'Catching up 3 missed cron ticks.',
    });

    const secondNote = String((runFire.mock.calls[1]![0] as { note?: unknown }).note ?? '');
    expect(secondNote).toContain('Catching up 3 missed cron ticks.');
    expect(secondNote).toContain('codex failed at the automation fire boundary (quota)');
  });

  it('never runs the handler of a rung whose breaker is already open', async () => {
    runFire.mockResolvedValue({
      outcome: { ok: true, value: 'done' },
      record: { runId: 'run-fire:failover:1:claude-code', ok: true },
    });
    const onFailover = vi.fn();

    await runAutomation({
      automationRef: 'app/digest',
      appsDir: '/apps',
      journalDbFile: '/j.db',
      runId: 'run-fire',
      runner: 'codex',
      runnerLadder: ['codex', 'claude-code'],
      runnerHealthContext: 'vault-1',
      runnerHealth: {
        canAttempt: (_context, kind) =>
          kind === 'codex'
            ? { allowed: false, failureClass: 'quota', breakerUntil: 5_000 }
            : { allowed: true },
        reportFailure: () => undefined,
        reportOk: () => undefined,
        reportPreflightOk: () => undefined,
        list: () => [],
      },
      onFailover,
    });

    // Exactly one fire: the condemned primary's handler never executed, so its
    // ctx.fetch / vault writes cannot be replayed by the fallback rung.
    expect(runFire).toHaveBeenCalledTimes(1);
    expect(runFire.mock.calls[0]![0]).toMatchObject({
      runId: 'run-fire:failover:1:claude-code',
      runnerKind: 'claude-code',
    });
    expect(onFailover).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'codex', to: 'claude-code', failureClass: 'quota' }),
    );
  });

  it('refuses the fire when every rung is circuit-broken instead of running a handler', async () => {
    await expect(
      runAutomation({
        automationRef: 'app/digest',
        appsDir: '/apps',
        journalDbFile: '/j.db',
        runner: 'codex',
        runnerHealthContext: 'vault-1',
        runnerHealth: {
          canAttempt: () => ({ allowed: false, failureClass: 'auth' }),
          reportFailure: () => undefined,
          reportOk: () => undefined,
          reportPreflightOk: () => undefined,
          list: () => [],
        },
      }),
    ).rejects.toThrow('no runner available');
    expect(runFire).not.toHaveBeenCalled();
  });

  it('marks a manifest-pinned runner as ladder-derived consent, not a direct grant', async () => {
    await runAutomation({
      automationRef: 'app/digest',
      appsDir: '/apps',
      journalDbFile: '/j.db',
      runner: 'gemini',
      runnerSelectionSource: 'manifest',
    });
    const deps = runFire.mock.calls[0]![1] as {
      openDispatch: (a: { workdir: string; runId: string }) => unknown;
    };
    deps.openDispatch({ workdir: '/w', runId: 'r' });
    expect(startLiveDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ runner: 'gemini', consentSource: 'ladder' }),
    );
  });
});
