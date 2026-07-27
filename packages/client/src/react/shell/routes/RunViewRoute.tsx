import { Store } from '../store.js';
import { type JSX, useEffect, useRef } from 'react';
import {
  readAutomation,
  readAutomationTurnExpanded,
  runAutomationNow,
  streamAutomationTurn,
  type AutomationTurnStreamEvent,
} from '../../../gateway-client.js';
import type { RunViewSnapshot } from '../../screen-contracts.js';
import RunViewScreen from '../../screens/RunViewScreen.js';
import { useShellActions } from '../actions.js';
import PageScroll from '../PageScroll.js';
import { buildRunSnapshot } from './runViewData.js';

// React-owned run viewer — replaces the vanilla renderRunView. The stream lives
// here (SSE via streamAutomationTurn): a local node model keyed by ordinal +
// accumulated streamed text, re-derived into a snapshot on each event and
// pushed to the RunViewScreen through its onReady updater (same contract the
// vanilla side used). Persisted timeline/log mode via Store.
export default function RunViewRoute({
  automationId,
  runId,
}: {
  automationId: string;
  runId: string;
}): JSX.Element {
  const { navigate, showToast } = useShellActions();
  const rowRef = useRef<CentraidAutomationRow | null>(null);
  const updateRef = useRef<((s: RunViewSnapshot | null) => void) | null>(null);
  // `navigate`/`showToast` come from context and get a new identity on every
  // App re-render; refs let the effect below use the latest without
  // restarting the run stream (which the fresh functions would trigger if
  // they were in its dependency array).
  const actionsRef = useRef({ navigate, showToast });
  useEffect(() => {
    actionsRef.current = { navigate, showToast };
  }, [navigate, showToast]);

  useEffect(() => {
    let stopped = false;
    const ac = new AbortController();
    let row: CentraidAutomationRow | null = null;
    let run: CentraidAutomationTurnRecord | null = null;
    const itemsById = new Map<string, CentraidAutomationItem>();
    const liveTextByOrdinal = new Map<number, string>();
    const sortedNodes = (): CentraidAutomationItem[] =>
      [...itemsById.values()].sort((a, b) => a.ordinal - b.ordinal || a.startedAt - b.startedAt);

    const rerender = (): void => {
      // `row` may be null — the automation was deleted but its run history
      // survives (the Automations overview keeps those runs visible too);
      // buildRunSnapshot degrades gracefully rather than requiring a row.
      if (stopped || !run || !updateRef.current) return;
      updateRef.current(buildRunSnapshot(row, run, sortedNodes(), liveTextByOrdinal));
    };

    const applyEvent = (ev: AutomationTurnStreamEvent): void => {
      if (ev.type === 'item.start') {
        const prev = itemsById.get(ev.itemId);
        itemsById.set(ev.itemId, {
          itemId: ev.itemId,
          turnId: runId,
          ordinal: ev.ordinal,
          ...(ev.callId === undefined ? {} : { callId: ev.callId }),
          ...(ev.batchId === undefined ? {} : { batchId: ev.batchId }),
          kind: ev.kind,
          ...(ev.name === undefined ? {} : { name: ev.name }),
          ...(ev.args === undefined ? {} : { argsJson: JSON.stringify(ev.args) }),
          ...(ev.rawJson === undefined ? {} : { rawJson: ev.rawJson }),
          ok: true,
          startedAt: prev?.startedAt ?? Date.now(),
        });
        rerender();
      } else if (ev.type === 'item.end') {
        const prev = itemsById.get(ev.itemId);
        const startedAt = prev?.startedAt ?? Date.now() - ev.durationMs;
        itemsById.set(ev.itemId, {
          itemId: ev.itemId,
          turnId: runId,
          ordinal: ev.ordinal,
          ...(ev.callId === undefined ? {} : { callId: ev.callId }),
          ...(prev?.batchId === undefined ? {} : { batchId: prev.batchId }),
          kind: prev?.kind ?? 'tool',
          ...(prev?.name === undefined ? {} : { name: prev.name }),
          ...(prev?.argsJson === undefined ? {} : { argsJson: prev.argsJson }),
          ...(ev.result === undefined ? {} : { outputJson: JSON.stringify(ev.result) }),
          ok: ev.ok,
          ...(ev.error === undefined ? {} : { error: ev.error }),
          ...(ev.rawJson === undefined ? {} : { rawJson: ev.rawJson }),
          startedAt,
          endedAt: startedAt + ev.durationMs,
          durationMs: ev.durationMs,
        });
        rerender();
      } else if (ev.type === 'turn.end') {
        void (async () => {
          const final = await readAutomationTurnExpanded({ turnId: runId }).catch(() => ({
            turn: null,
            items: [] as CentraidAutomationItem[],
          }));
          if (stopped) return;
          if (final.turn) run = final.turn;
          else if (run)
            run = {
              ...run,
              ok: ev.ok,
              endedAt: Date.now(),
              ...(ev.error ? { error: ev.error } : {}),
            };
          if (final.items.length > 0) {
            itemsById.clear();
            for (const item of final.items) itemsById.set(item.itemId, item);
          }
          rerender();
        })();
      } else if (ev.type === 'item.delta') {
        const inner = ev.event as { type?: string; delta?: string };
        if (inner?.type === 'assistant.delta' && typeof inner.delta === 'string') {
          liveTextByOrdinal.set(
            ev.ordinal,
            (liveTextByOrdinal.get(ev.ordinal) ?? '') + inner.delta,
          );
          rerender();
        }
      }
    };

    void (async () => {
      try {
        const [loadedRow, expanded] = await Promise.all([
          readAutomation({ automationId }),
          readAutomationTurnExpanded({ turnId: runId }),
        ]);
        row = loadedRow;
        run = expanded.turn;
        for (const item of expanded.items) itemsById.set(item.itemId, item);
      } catch {
        return;
      }
      if (stopped) return;
      if (row) {
        rowRef.current = row;
      } else if (!run) {
        // Automation deleted and no run record survived either — there is
        // nothing recoverable to show. Bounce back to the overview (the only
        // place this run id could have been clicked from) instead of
        // stranding the user on a permanent loading screen.
        actionsRef.current.navigate({ kind: 'automations' });
        actionsRef.current.showToast(
          'That automation was deleted, and its run history is gone too.',
        );
        return;
      }
      if (!run) {
        run = {
          turnId: runId,
          conversationId: automationId,
          seq: 0,
          automationId,
          triggerKind: 'manual',
          startedAt: Date.now(),
          ok: false,
          pinned: false,
        };
      }
      rerender();
      try {
        await streamAutomationTurn(runId, applyEvent, ac.signal);
      } catch {
        // Stream unavailable (older gateway) — one-shot ledger read fallback.
        if (stopped) return;
        const expanded = await readAutomationTurnExpanded({ turnId: runId }).catch(() => ({
          turn: run,
          items: [] as CentraidAutomationItem[],
        }));
        if (expanded.turn) run = expanded.turn;
        itemsById.clear();
        for (const item of expanded.items) itemsById.set(item.itemId, item);
        rerender();
      }
    })();

    return () => {
      stopped = true;
      ac.abort();
    };
  }, [automationId, runId]);

  const initialMode =
    Store.get<'timeline' | 'log'>('automations.runViewMode', 'timeline') ?? 'timeline';

  return (
    <PageScroll>
      <RunViewScreen
        initialMode={initialMode}
        onReady={(u) => {
          updateRef.current = u;
        }}
        onBack={() => navigate({ kind: 'automations' })}
        onOpenAutomation={() => {
          const row = rowRef.current;
          if (row) navigate({ kind: 'automation-view', automationId: row.ref });
        }}
        onRunAgain={() => {
          const row = rowRef.current;
          if (!row) return;
          const ref = row.ref;
          void runAutomationNow({ automationId: ref })
            .then(({ turnId }) => navigate({ kind: 'run-view', automationId: ref, runId: turnId }))
            .catch((err: unknown) =>
              showToast(`Run failed: ${err instanceof Error ? err.message : String(err)}`),
            );
        }}
        onSetMode={(m) => Store.set('automations.runViewMode', m)}
      />
    </PageScroll>
  );
}
