import { useEffect, useRef } from "react";
import type { JSX } from "react";

import {
  readAutomation,
  readAutomationTurnExpanded,
  runAutomationNow,
  streamAutomationTurn,
} from "../../../gateway-client.js";
import type { AutomationTurnStreamEvent } from "../../../gateway-client.js";
import type { RunViewSnapshot } from "../../screen-contracts.js";
import RunViewScreen from "../../screens/RunViewScreen.js";
import { useShellActions } from "../actions.js";
import PageScroll from "../PageScroll.js";
import { Store } from "../store.js";
import { buildRunSnapshot } from "./runViewData.js";

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
      [...itemsById.values()].sort(
        (a, b) => a.ordinal - b.ordinal || a.startedAt - b.startedAt
      );

    const rerender = (): void => {
      if (stopped || !run || !updateRef.current) return;
      updateRef.current(
        buildRunSnapshot(row, run, sortedNodes(), liveTextByOrdinal)
      );
    };

    const applyEvent = (ev: AutomationTurnStreamEvent): void => {
      if (ev.type === "item.start") {
        const prev = itemsById.get(ev.itemId);
        itemsById.set(ev.itemId, {
          itemId: ev.itemId,
          turnId: runId,
          ordinal: ev.ordinal,
          ...(ev.callId === undefined ? {} : { callId: ev.callId }),
          ...(ev.batchId === undefined ? {} : { batchId: ev.batchId }),
          kind: ev.kind,
          ...(ev.name === undefined ? {} : { name: ev.name }),
          ...(ev.args === undefined
            ? {}
            : { argsJson: JSON.stringify(ev.args) }),
          ...(ev.rawJson === undefined ? {} : { rawJson: ev.rawJson }),
          ok: true,
          startedAt: prev?.startedAt ?? Date.now(),
        });
        rerender();
      } else if (ev.type === "item.end") {
        const prev = itemsById.get(ev.itemId);
        const startedAt = prev?.startedAt ?? Date.now() - ev.durationMs;
        itemsById.set(ev.itemId, {
          itemId: ev.itemId,
          turnId: runId,
          ordinal: ev.ordinal,
          ...(ev.callId === undefined ? {} : { callId: ev.callId }),
          ...(prev?.batchId === undefined ? {} : { batchId: prev.batchId }),
          kind: prev?.kind ?? "tool",
          ...(prev?.name === undefined ? {} : { name: prev.name }),
          ...(prev?.argsJson === undefined ? {} : { argsJson: prev.argsJson }),
          ...(ev.result === undefined
            ? {}
            : { outputJson: JSON.stringify(ev.result) }),
          ok: ev.ok,
          ...(ev.error === undefined ? {} : { error: ev.error }),
          ...(ev.rawJson === undefined ? {} : { rawJson: ev.rawJson }),
          startedAt,
          endedAt: startedAt + ev.durationMs,
          durationMs: ev.durationMs,
        });
        rerender();
      } else if (ev.type === "turn.end") {
        void (async () => {
          const final = await readAutomationTurnExpanded({
            turnId: runId,
          }).catch(() => ({
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
      } else if (ev.type === "item.delta") {
        const inner = ev.event as { type?: string; delta?: string };
        if (
          inner?.type === "assistant.delta" &&
          typeof inner.delta === "string"
        ) {
          liveTextByOrdinal.set(
            ev.ordinal,
            (liveTextByOrdinal.get(ev.ordinal) ?? "") + inner.delta
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
        actionsRef.current.navigate({ kind: "automations" });
        actionsRef.current.showToast(
          "That automation was deleted, and its run history is gone too."
        );
        return;
      }
      if (!run) {
        run = {
          turnId: runId,
          conversationId: automationId,
          seq: 0,
          automationId,
          triggerKind: "manual",
          startedAt: Date.now(),
          ok: false,
          pinned: false,
        };
      }
      rerender();
      try {
        await streamAutomationTurn(runId, applyEvent, ac.signal);
      } catch {
        if (stopped) return;
        const expanded = await readAutomationTurnExpanded({
          turnId: runId,
        }).catch(() => ({
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
    Store.get<"timeline" | "log">("automations.runViewMode", "timeline") ??
    "timeline";

  return (
    <PageScroll>
      <RunViewScreen
        initialMode={initialMode}
        onReady={(u) => {
          updateRef.current = u;
        }}
        onBack={() => navigate({ kind: "automations" })}
        onOpenAutomation={() => {
          const row = rowRef.current;
          if (row) navigate({ kind: "automation-view", automationId: row.ref });
        }}
        onRunAgain={() => {
          const row = rowRef.current;
          if (!row) return;
          const ref = row.ref;
          void runAutomationNow({ automationId: ref })
            .then(({ turnId }) =>
              navigate({ kind: "run-view", automationId: ref, runId: turnId })
            )
            .catch((error: unknown) =>
              showToast(
                `Run failed: ${error instanceof Error ? error.message : String(error)}`
              )
            );
        }}
        onSetMode={(m) => Store.set("automations.runViewMode", m)}
      />
    </PageScroll>
  );
}
