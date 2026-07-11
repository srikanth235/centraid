import { Store } from '../store.js';
import { type JSX, useEffect, useRef } from 'react';
import {
  listAutomationRunNodes,
  readAutomation,
  readAutomationRun,
  runAutomationNow,
  streamAutomationRun,
  type RunStreamEvent,
} from '../../../gateway-client.js';
import type { RunViewSnapshot } from '../../screen-contracts.js';
import RunViewScreen from '../../screens/RunViewScreen.js';
import { useShellActions } from '../actions.js';
import PageScroll from '../PageScroll.js';
import { buildRunSnapshot } from './runViewData.js';

// React-owned run viewer — replaces the vanilla renderRunView. The stream lives
// here (SSE via streamAutomationRun): a local node model keyed by ordinal +
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

  useEffect(() => {
    let stopped = false;
    const ac = new AbortController();
    let row: CentraidAutomationRow | null = null;
    let run: CentraidAutomationRunRecord | null = null;
    const nodesByOrdinal = new Map<number, CentraidAutomationRunNode>();
    const liveTextByOrdinal = new Map<number, string>();
    const sortedNodes = (): CentraidAutomationRunNode[] =>
      [...nodesByOrdinal.values()].sort((a, b) => a.ordinal - b.ordinal);

    const rerender = (): void => {
      // `row` may be null — the automation was deleted but its run history
      // survives (the Automations overview keeps those runs visible too);
      // buildRunSnapshot degrades gracefully rather than requiring a row.
      if (stopped || !run || !updateRef.current) return;
      updateRef.current(buildRunSnapshot(row, run, sortedNodes(), liveTextByOrdinal));
    };

    const applyEvent = (ev: RunStreamEvent): void => {
      if (ev.type === 'node.start') {
        const prev = nodesByOrdinal.get(ev.ordinal);
        nodesByOrdinal.set(ev.ordinal, {
          nodeId: prev?.nodeId ?? `${runId}:${ev.ordinal}`,
          runId,
          ordinal: ev.ordinal,
          ...(ev.batchId !== undefined ? { batchId: ev.batchId } : {}),
          kind: ev.kind,
          ...(ev.name !== undefined ? { name: ev.name } : {}),
          ...(ev.args !== undefined ? { argsJson: JSON.stringify(ev.args) } : {}),
          ok: true,
          startedAt: prev?.startedAt ?? Date.now(),
        });
        rerender();
      } else if (ev.type === 'node.end') {
        const prev = nodesByOrdinal.get(ev.ordinal);
        const startedAt = prev?.startedAt ?? Date.now() - ev.durationMs;
        nodesByOrdinal.set(ev.ordinal, {
          nodeId: prev?.nodeId ?? `${runId}:${ev.ordinal}`,
          runId,
          ordinal: ev.ordinal,
          ...(prev?.batchId !== undefined ? { batchId: prev.batchId } : {}),
          kind: prev?.kind ?? 'tool',
          ...(prev?.name !== undefined ? { name: prev.name } : {}),
          ...(prev?.argsJson !== undefined ? { argsJson: prev.argsJson } : {}),
          ...(ev.result !== undefined ? { outputJson: JSON.stringify(ev.result) } : {}),
          ok: ev.ok,
          ...(ev.error !== undefined ? { error: ev.error } : {}),
          startedAt,
          endedAt: startedAt + ev.durationMs,
          durationMs: ev.durationMs,
        });
        rerender();
      } else if (ev.type === 'run.end') {
        void (async () => {
          const [finalRun, finalNodes] = await Promise.all([
            readAutomationRun({ runId }).catch(() => null),
            listAutomationRunNodes({ runId }).catch(() => []),
          ]);
          if (stopped) return;
          if (finalRun) run = finalRun;
          else if (run)
            run = {
              ...run,
              ok: ev.ok,
              endedAt: Date.now(),
              ...(ev.error ? { error: ev.error } : {}),
            };
          if (finalNodes.length > 0) {
            nodesByOrdinal.clear();
            for (const n of finalNodes) nodesByOrdinal.set(n.ordinal, n);
          }
          rerender();
        })();
      } else if (ev.type === 'node.delta') {
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
        [row, run] = await Promise.all([
          readAutomation({ automationId }),
          readAutomationRun({ runId }),
        ]);
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
        navigate({ kind: 'automations' });
        showToast('That automation was deleted, and its run history is gone too.');
        return;
      }
      if (!run) {
        run = {
          runId,
          kind: 'automation',
          automationId,
          triggerKind: 'manual',
          startedAt: Date.now(),
          ok: false,
          pinned: false,
        };
      }
      rerender();
      try {
        await streamAutomationRun(runId, applyEvent, ac.signal);
      } catch {
        // Stream unavailable (older gateway) — one-shot ledger read fallback.
        if (stopped) return;
        const [fr, fn] = await Promise.all([
          readAutomationRun({ runId }).catch(() => run),
          listAutomationRunNodes({ runId }).catch(() => [] as CentraidAutomationRunNode[]),
        ]);
        if (fr) run = fr;
        nodesByOrdinal.clear();
        for (const n of fn) nodesByOrdinal.set(n.ordinal, n);
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
            .then(({ runId: rid }) => navigate({ kind: 'run-view', automationId: ref, runId: rid }))
            .catch((err: unknown) =>
              showToast(`Run failed: ${err instanceof Error ? err.message : String(err)}`),
            );
        }}
        onSetMode={(m) => Store.set('automations.runViewMode', m)}
      />
    </PageScroll>
  );
}
