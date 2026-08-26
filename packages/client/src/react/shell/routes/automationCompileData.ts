/*
 * Compile-workbench data layer: a compile is an ordinary automation turn read
 * as STEPS, not chat messages. The run screen never calls this file — that
 * keeps compile turns out of run history.
 */
import { relativeTime } from "../../../app-format.js";
import {
  listAutomationTurns,
  readAutomationTurnExpanded,
  streamAutomationTurn,
} from "../../../gateway-client.js";
import type { AutomationTurnStreamEvent } from "../../../gateway-client.js";
import type {
  CompileAttemptDTO,
  CompileStepDTO,
  TurnWatchOutcome,
} from "../../screen-contracts.js";

/** Step-row detail length: recognisable, still a list; full text one click away. */
const DETAIL_CHARS = 160;

function clip(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > DETAIL_CHARS
    ? `${flat.slice(0, DETAIL_CHARS - 1)}…`
    : flat;
}

/** First readable line of a tool payload — not the raw JSON envelope noise. */
function payloadDetail(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") return clip(parsed);
    if (parsed && typeof parsed === "object") {
      for (const key of ["path", "file", "message", "summary", "text"]) {
        const value = (parsed as Record<string, unknown>)[key];
        if (typeof value === "string" && value.trim()) return clip(value);
      }
      return null;
    }
    return null;
  } catch {
    return clip(raw);
  }
}

function stepLabel(item: CentraidAutomationItem): string {
  if (item.name) return item.name;
  if (item.kind === "step")
    return item.model ? `Model · ${item.model}` : "Model step";
  if (item.kind === "delegate") return "Delegate";
  return "Step";
}

/** One ledger item → one step row; `message_in` items are dropped (already
 *  the left-hand pane of this screen). */
export function compileStepOf(
  item: CentraidAutomationItem
): CompileStepDTO | null {
  if (item.kind === "message_in") return null;
  const running = item.endedAt === undefined && !item.error;
  const detail = item.error
    ? clip(item.error)
    : (payloadDetail(item.outputJson) ??
      payloadDetail(item.argsJson) ??
      (item.text ? clip(item.text) : null));
  return {
    itemId: item.itemId,
    ordinal: item.ordinal,
    kind: item.kind,
    label: stepLabel(item),
    status: running ? "running" : item.ok ? "ok" : "fail",
    durationMs: item.durationMs ?? null,
    detail,
  };
}

export function compileSteps(
  items: readonly CentraidAutomationItem[]
): CompileStepDTO[] {
  return items
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal || a.startedAt - b.startedAt)
    .map(compileStepOf)
    .filter((step): step is CompileStepDTO => step !== null);
}

export function compileAttemptOf(
  turn: CentraidAutomationTurnRecord
): CompileAttemptDTO {
  return {
    turnId: turn.turnId,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt ?? null,
    status: turn.endedAt === undefined ? "running" : turn.ok ? "ok" : "fail",
    error: turn.error ?? null,
    summary: turn.summary ?? null,
    whenLabel: relativeTime(new Date(turn.startedAt).toISOString()),
  };
}

/** This automation's compile attempts, newest first. */
export async function loadCompileAttempts(
  automationId: string
): Promise<CompileAttemptDTO[]> {
  const turns = await listAutomationTurns({ automationId, limit: 40 });
  return turns
    .filter((turn) => turn.triggerKind === "compile")
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(compileAttemptOf);
}

/** Cold read of one turn's steps: finished-attempt scrollback, and first
 *  paint before a live stream takes over. */
export async function loadTurnSteps(turnId: string): Promise<CompileStepDTO[]> {
  const expanded = await readAutomationTurnExpanded({ turnId });
  return compileSteps(expanded.items);
}

/**
 * Watch a compile (or test-run) turn as STEPS. Mirrors `automationTurnWatch.ts`'s
 * contract exactly (same settled/ok semantics, same single authoritative
 * post-stream ledger re-read) but folds events into ledger-shaped items.
 */
export async function watchTurnSteps(
  turnId: string,
  onSteps: (steps: CompileStepDTO[]) => void,
  signal: AbortSignal
): Promise<TurnWatchOutcome> {
  const items = new Map<string, CentraidAutomationItem>();
  const initial = await readAutomationTurnExpanded({ turnId }).catch(() => ({
    turn: null,
    items: [] as CentraidAutomationItem[],
  }));
  for (const item of initial.items) items.set(item.itemId, item);
  if (items.size > 0) onSteps(compileSteps([...items.values()]));

  let ended = false;
  let terminalOk: boolean | undefined;
  const apply = (event: AutomationTurnStreamEvent): void => {
    if (event.type === "item.start") {
      const prev = items.get(event.itemId);
      items.set(event.itemId, {
        itemId: event.itemId,
        turnId,
        ordinal: event.ordinal,
        kind: event.kind,
        ...(event.name === undefined ? {} : { name: event.name }),
        ...(event.args === undefined
          ? {}
          : { argsJson: JSON.stringify(event.args) }),
        ok: true,
        startedAt: prev?.startedAt ?? Date.now(),
      });
      onSteps(compileSteps([...items.values()]));
    } else if (event.type === "item.end") {
      const prev = items.get(event.itemId);
      const startedAt = prev?.startedAt ?? Date.now() - event.durationMs;
      items.set(event.itemId, {
        ...(prev ?? {
          itemId: event.itemId,
          turnId,
          ordinal: event.ordinal,
          kind: "tool",
        }),
        itemId: event.itemId,
        turnId,
        ordinal: event.ordinal,
        kind: prev?.kind ?? "tool",
        ...(event.result === undefined
          ? {}
          : { outputJson: JSON.stringify(event.result) }),
        ok: event.ok,
        ...(event.error === undefined ? {} : { error: event.error }),
        startedAt,
        endedAt: startedAt + event.durationMs,
        durationMs: event.durationMs,
      });
      onSteps(compileSteps([...items.values()]));
    } else if (event.type === "turn.end") {
      ended = true;
      terminalOk = event.ok;
    }
  };
  await streamAutomationTurn(turnId, apply, signal);
  if (signal.aborted) return { settled: false, ok: false };
  const final = await readAutomationTurnExpanded({ turnId });
  if (final.turn) {
    onSteps(compileSteps(final.items));
    return { settled: final.turn.endedAt !== undefined, ok: final.turn.ok };
  }
  return { settled: ended, ok: terminalOk ?? false };
}
