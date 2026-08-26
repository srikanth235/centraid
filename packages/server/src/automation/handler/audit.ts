/** Audit-row helpers for automation handler runs (#80). */

import { randomUUID } from "node:crypto";

import type {
  ConversationStore,
  ItemKind,
  Turn,
  AutomationTriggerKind,
  TurnStreamEvent,
  AutomationTurnStreamEvent,
} from "@centraid/server/engine";
import { resolveItemCost } from "@centraid/server/engine";

import type { HistoryConfig } from "../manifest/manifest.js";

/** Live run-stream sink (#158), wired by the host to its `runId`-keyed bus;
 *  unwired it's a no-op (the durable ledger still records every node). Every
 *  emit is guarded — a wedged sink must never fail the handler. */
export type RunEventSink = (ev: AutomationTurnStreamEvent) => void;
export const noopRunEventSink: RunEventSink = () => undefined;

const AUDIT_FIELD_BYTE_CAP = 64 * 1024; // args_json / output_json per node.

/** Capped stringify; oversize payloads become a `{_truncated, bytes, head}` envelope. */
export function truncateForAudit(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return JSON.stringify({ _truncated: true, reason: "unserializable" });
  }
  if (json.length <= AUDIT_FIELD_BYTE_CAP) return json;
  return JSON.stringify({
    _truncated: true,
    bytes: json.length,
    head: json.slice(0, 256),
  });
}

export interface RunRef {
  runId: string;
  automationId: string;
  triggerKind: AutomationTriggerKind;
  startedAt: number;
  endedAt?: number;
  ok: boolean;
  error?: string;
  summary?: string;
  input?: unknown;
  output?: unknown;
}

/** Project a `turns` row into the handler-facing `ctx.runs` ref
 *  (`automationRef` is the automation's stable id, not a conversation id). */
export function rowToRunRef(
  row: Turn,
  automationRef: string,
  inputText?: string
): RunRef {
  const ref: RunRef = {
    runId: row.turnId,
    automationId: automationRef,
    triggerKind: row.triggerKind,
    startedAt: row.startedAt,
    ok: row.ok,
  };
  if (row.endedAt !== undefined) ref.endedAt = row.endedAt;
  if (row.error !== undefined) ref.error = row.error;
  if (row.summary !== undefined) ref.summary = row.summary;
  if (inputText !== undefined) {
    try {
      ref.input = JSON.parse(inputText) as unknown;
    } catch {
      ref.input = inputText;
    }
  }
  if (row.outputJson !== undefined) {
    try {
      ref.output = JSON.parse(row.outputJson) as unknown;
    } catch {
      ref.output = row.outputJson;
    }
  }
  return ref;
}

export function applyRetention(
  store: ConversationStore,
  automationRef: string,
  history: HistoryConfig | undefined
): void {
  if (!history) return;
  const keep = history.keep;
  if (keep === "all") return;
  if (keep === "errors") {
    store.pruneAutomation(automationRef, { errorsOnly: true });
    return;
  }
  if ("count" in keep) {
    store.pruneAutomation(automationRef, { count: keep.count });
    return;
  }
  if ("days" in keep) store.pruneAutomation(automationRef, { days: keep.days });
}

export interface HandlerReturnEnvelope {
  value: unknown;
  summary?: string;
  output?: unknown;
}

/** Pull `{ summary?, output? }` out of a handler's object return; anything else is ignored. */
export function extractReturnEnvelope(value: unknown): HandlerReturnEnvelope {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    const env: HandlerReturnEnvelope = { value };
    if (typeof v.summary === "string") env.summary = v.summary;
    if ("output" in v) env.output = v.output;
    return env;
  }
  return { value };
}

export function makeNodeId(runId: string, ordinal: number): string {
  return `${runId}:${ordinal}:${randomUUID().slice(0, 6)}`;
}

export interface OpenRunNodeArgs {
  store: ConversationStore;
  emit: RunEventSink;
  runId: string;
  ordinal: number;
  /** Stable harness-native correlation key for overlapping tool calls. */
  callId?: string;
  batchId?: number;
  kind: ItemKind;
  /** Tool name or `'delegate'`. */
  name?: string;
  args?: unknown;
  /** Lossless harness event envelope, when one exists. */
  rawJson?: string;
  started: number;
}

/** Open a durable "running" node (#158) AND publish `item.start`; failures swallowed. */
export function openRunNode(args: OpenRunNodeArgs): string {
  const nodeId = makeNodeId(args.runId, args.ordinal);
  const argsJson =
    args.args === undefined ? undefined : (truncateForAudit(args.args) ?? "");
  try {
    args.store.openItem({
      itemId: nodeId,
      turnId: args.runId,
      ordinal: args.ordinal,
      ...(args.callId === undefined ? {} : { callId: args.callId }),
      ...(args.batchId === undefined ? {} : { batchId: args.batchId }),
      kind: args.kind,
      ...(args.name === undefined ? {} : { name: args.name }),
      ...(argsJson === undefined ? {} : { argsJson }),
      ...(args.rawJson === undefined ? {} : { rawJson: args.rawJson }),
      startedAt: args.started,
    });
  } catch {
    /* never let audit failures bubble */
  }
  try {
    args.emit({
      type: "item.start",
      itemId: nodeId,
      ordinal: args.ordinal,
      ...(args.callId === undefined ? {} : { callId: args.callId }),
      ...(args.batchId === undefined ? {} : { batchId: args.batchId }),
      kind: args.kind,
      ...(args.name === undefined ? {} : { name: args.name }),
      ...(args.args === undefined ? {} : { args: args.args }),
      ...(args.rawJson === undefined ? {} : { rawJson: args.rawJson }),
    });
  } catch {
    /* swallow */
  }
  return nodeId;
}

/** Map a chat `usage` event (#158) onto `closeRunNode`'s token/model fields; `{}` when none observed. */
export function usageCloseFields(
  usage: Extract<TurnStreamEvent, { type: "usage" }> | undefined
): Partial<CloseRunNodeArgs> {
  if (!usage) return {};
  // Prefer harness cost; catalog fill happens in closeRunNode (#514).
  const costSource =
    usage.costSource ??
    (usage.costUsd === undefined ? undefined : ("harness" as const));
  return {
    ...(usage.model === undefined ? {} : { model: usage.model }),
    ...(usage.harness === undefined ? {} : { harness: usage.harness }),
    ...(usage.inputTokens === undefined
      ? {}
      : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined
      ? {}
      : { outputTokens: usage.outputTokens }),
    ...(usage.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
    ...(costSource === undefined ? {} : { costSource }),
  };
}

export interface CloseRunNodeArgs {
  store: ConversationStore;
  emit: RunEventSink;
  nodeId: string;
  ordinal: number;
  callId?: string;
  ok: boolean;
  result?: unknown;
  /** Lossless harness completion envelope, when one exists. */
  rawJson?: string;
  error?: string;
  /** Child turn id for an item that spawned one. Dormant — no current producer. */
  childTurnId?: string;
  started: number;
  ended: number;
  /** Token/model rollup for a `delegate` node (#158); feeds `runs.total_*`. */
  model?: string;
  harness?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  costSource?: "harness" | "estimated";
}

/** Settle an open node: ledger write AND `item.end`. Bus carries untruncated
 *  values (ephemeral); the ledger keeps the capped copies. */
export function closeRunNode(args: CloseRunNodeArgs): void {
  const durationMs = args.ended - args.started;
  const outputJson =
    args.ok && args.result !== undefined
      ? (truncateForAudit(args.result) ?? "")
      : undefined;
  const usage = {
    ...(args.inputTokens === undefined
      ? {}
      : { inputTokens: args.inputTokens }),
    ...(args.outputTokens === undefined
      ? {}
      : { outputTokens: args.outputTokens }),
    ...(args.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: args.cacheReadTokens }),
    ...(args.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: args.cacheWriteTokens }),
  };
  const priced =
    args.costSource === "harness" && args.costUsd !== undefined
      ? { costUsd: args.costUsd, costSource: "harness" as const }
      : args.costSource === "estimated" && args.costUsd !== undefined
        ? { costUsd: args.costUsd, costSource: "estimated" as const }
        : resolveItemCost({
            ...(args.costUsd === undefined
              ? {}
              : { harnessCostUsd: args.costUsd }),
            model: args.model,
            usage,
          });
  try {
    args.store.closeItem({
      itemId: args.nodeId,
      ok: args.ok,
      ...(outputJson === undefined ? {} : { outputJson }),
      ...(args.rawJson === undefined ? {} : { rawJson: args.rawJson }),
      ...(args.error === undefined ? {} : { error: args.error }),
      ...(args.childTurnId === undefined
        ? {}
        : { childTurnId: args.childTurnId }),
      endedAt: args.ended,
      durationMs,
      ...(args.model === undefined ? {} : { model: args.model }),
      ...(args.harness === undefined ? {} : { harness: args.harness }),
      ...(args.inputTokens === undefined
        ? {}
        : { inputTokens: args.inputTokens }),
      ...(args.outputTokens === undefined
        ? {}
        : { outputTokens: args.outputTokens }),
      ...(args.cacheReadTokens === undefined
        ? {}
        : { cacheReadTokens: args.cacheReadTokens }),
      ...(args.cacheWriteTokens === undefined
        ? {}
        : { cacheWriteTokens: args.cacheWriteTokens }),
      ...(priced.costUsd === undefined ? {} : { costUsd: priced.costUsd }),
      ...(priced.costSource === undefined
        ? {}
        : { costSource: priced.costSource }),
    });
  } catch {
    /* swallow */
  }
  try {
    args.emit({
      type: "item.end",
      itemId: args.nodeId,
      ordinal: args.ordinal,
      ...(args.callId === undefined ? {} : { callId: args.callId }),
      ok: args.ok,
      ...(args.result === undefined ? {} : { result: args.result }),
      ...(args.error === undefined ? {} : { error: args.error }),
      durationMs,
      ...(args.rawJson === undefined ? {} : { rawJson: args.rawJson }),
    });
  } catch {
    /* swallow */
  }
}
