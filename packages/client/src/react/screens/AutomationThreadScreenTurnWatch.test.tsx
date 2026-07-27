// Live-turn resilience for the automation thread: bounded rejoin of a dropped
// SSE stream (and the explicit Rejoin affordance once it gives up), stopping
// the moment the ledger says the turn settled, not re-reading a trace the
// watcher already owns, and the retry offered when a cold trace read fails.
// Header / consent / composer / rendering behaviour stays in
// AutomationThreadScreen.test.tsx. Split from that file (500-line repo-hygiene
// cap); shared fixtures in AutomationThreadScreen.test-fixtures.tsx.

import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AutomationThreadBridgeProps } from '../screen-contracts.js';
import {
  installThreadHarness,
  makeData,
  makeProps,
  mount,
  newestFirst,
} from './AutomationThreadScreen.test-fixtures.js';

installThreadHarness();

describe('AutomationThreadScreen — live turn watch', () => {
  it('rejoins a dropped turn stream instead of spinning forever, then gives up with a retry', async () => {
    vi.useFakeTimers();
    try {
      // Every join is refused (the gateway's SSE subscriber cap answers 503,
      // or the socket just dies) — the screen must keep trying, bounded.
      const watchTurn = vi
        .fn<AutomationThreadBridgeProps['watchTurn']>()
        .mockRejectedValue(new Error('HTTP 503'));
      const props = makeProps({ watchTurn }, newestFirst());
      const el = await mount(props);
      // The auto-watch effect joins the still-running latest turn (r3).
      expect(watchTurn).toHaveBeenCalledOnce();
      expect(watchTurn.mock.calls[0]?.[0]).toBe('r3');

      // Four bounded rejoins, each after its backoff.
      for (const delay of [500, 1500, 4000, 10_000]) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(delay);
        });
      }
      expect(watchTurn).toHaveBeenCalledTimes(5);

      // Bounded: it stops rather than hammering, and says so.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(watchTurn).toHaveBeenCalledTimes(5);
      const lost = el.querySelector<HTMLElement>('[data-testid="turn-watch-lost"]');
      expect(lost?.textContent).toContain('Lost the live connection');

      // The reader can rejoin explicitly.
      const rejoin = el.querySelector<HTMLButtonElement>('[data-testid="rejoin-turn"]');
      await act(async () => rejoin?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(watchTurn).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops rejoining as soon as the ledger says the turn settled', async () => {
    vi.useFakeTimers();
    try {
      const watchTurn = vi
        .fn<AutomationThreadBridgeProps['watchTurn']>()
        .mockRejectedValueOnce(new Error('stream closed'))
        .mockResolvedValue(true);
      const el = await mount(makeProps({ watchTurn }, newestFirst()));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(watchTurn).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(watchTurn).toHaveBeenCalledTimes(2);
      expect(el.querySelector('[data-testid="turn-watch-lost"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-reads nothing extra once a watch settles — the watcher owns that read', async () => {
    const watchTurn = vi.fn<AutomationThreadBridgeProps['watchTurn']>().mockResolvedValue(true);
    const props = makeProps({ watchTurn }, newestFirst());
    await mount(props);
    // r3 is watched, so its cold trace is fetched exactly once by the warm
    // auto-load — never again after the stream settles (#541).
    const colds = (props.loadTurnTrace as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([turnId]) => turnId === 'r3',
    );
    expect(colds).toHaveLength(1);
  });

  it('offers a retry when a cold trace read fails instead of faking an empty turn', async () => {
    const loadTurnTrace = vi
      .fn<AutomationThreadBridgeProps['loadTurnTrace']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([
        {
          kind: 'ai' as const,
          streaming: false as const,
          html: 'late',
          error: false,
          copyText: 'late',
          feedback: null,
        },
      ]);
    // Settled runs only, so nothing is watched and the read failure stands.
    const data = makeData();
    data.runs = data.runs.filter((r) => r.status !== 'running');
    const el = await mount(makeProps({ loadTurnTrace }, data));

    const notice = el.querySelector<HTMLElement>('[data-testid="turn-trace-error"]');
    expect(notice?.textContent).toContain('Couldn’t load this turn’s transcript.');
    // A failed read is NOT an empty trace: the settled turn must not render
    // the "Working through your instructions…" spinner.
    expect(el.textContent).not.toContain('Working through your instructions');
    // …and the turn keeps its Show-trace affordance rather than losing it.
    expect(el.querySelector('[data-testid="show-trace"]')).toBeTruthy();

    const retry = el.querySelector<HTMLButtonElement>('[data-testid="retry-trace"]');
    await act(async () => retry?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(loadTurnTrace).toHaveBeenCalledTimes(2);
    expect(el.querySelector('[data-testid="turn-trace-error"]')).toBeNull();
    expect(el.textContent).toContain('late');
  });
});
