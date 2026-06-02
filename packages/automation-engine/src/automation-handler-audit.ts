/**
 * Audit-row helpers for automation handler runs (issue #80).
 *
 * Split out of `automation-handler-runner.ts` so the runner stays
 * focused on worker/message orchestration. Everything here is
 * pure-ish — the only side-effect surface is the supplied
 * `AgentRunsStore` reference.
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentRunsStore,
  AgentRunNodeKind,
  AgentRunRow,
  AutomationTriggerKind,
  ChatStreamEvent,
  RunStreamEvent,
} from '@centraid/app-engine';
import type { AutomationHistoryConfig } from './automation-manifest.js';

/**
 * Sink for live run-stream events (issue #158). The host wires this to its
 * `runId`-keyed bus; when unwired it's a no-op (the durable ledger still
 * records every node). A wedged sink must never fail the handler — every
 * emit is guarded.
 */
export type RunEventSink = (ev: RunStreamEvent) => void;
export const noopRunEventSink: RunEventSink = () => undefined;

const AUDIT_FIELD_BYTE_CAP = 64 * 1024; // 64 KB hard cap on args_json / output_json per node.

/**
 * Stringify a value for an audit field, capping the byte length at
 * 64 KB. Oversize payloads are replaced with a `{_truncated, bytes,
 * head}` envelope so the UI / debugging path can see the size without
 * blowing up the file.
 */
export function truncateForAudit(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return JSON.stringify({ _truncated: true, reason: 'unserializable' });
  }
  if (json.length <= AUDIT_FIELD_BYTE_CAP) return json;
  return JSON.stringify({ _truncated: true, bytes: json.length, head: json.slice(0, 256) });
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

export function rowToRunRef(row: AgentRunRow): RunRef {
  const ref: RunRef = {
    runId: row.runId,
    automationId: row.automationId ?? '',
    triggerKind: row.triggerKind,
    startedAt: row.startedAt,
    ok: row.ok,
  };
  if (row.endedAt !== undefined) ref.endedAt = row.endedAt;
  if (row.error !== undefined) ref.error = row.error;
  if (row.summary !== undefined) ref.summary = row.summary;
  if (row.inputJson !== undefined) {
    try {
      ref.input = JSON.parse(row.inputJson) as unknown;
    } catch {
      ref.input = row.inputJson;
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
  store: AgentRunsStore,
  automationId: string,
  history: AutomationHistoryConfig | undefined,
): void {
  if (!history) return;
  const keep = history.keep;
  if (keep === 'all') return;
  if (keep === 'errors') {
    store.prune(automationId, { errorsOnly: true });
    return;
  }
  if ('count' in keep) {
    store.prune(automationId, { count: keep.count });
    return;
  }
  if ('days' in keep) store.prune(automationId, { days: keep.days });
}

export interface HandlerReturnEnvelope {
  value: unknown;
  summary?: string;
  output?: unknown;
}

/**
 * Pull `{ summary, output }` out of a handler's return value. Handlers
 * may return undefined (no-op) or `{ summary?, output? }`. Anything
 * else (bare string, number, array) is ignored — `summary` is only
 * picked up from a returned object.
 */
export function extractReturnEnvelope(value: unknown): HandlerReturnEnvelope {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    const env: HandlerReturnEnvelope = { value };
    if (typeof v.summary === 'string') env.summary = v.summary;
    if ('output' in v) env.output = v.output;
    return env;
  }
  return { value };
}

export function makeNodeId(runId: string, ordinal: number): string {
  return `${runId}:${ordinal}:${randomUUID().slice(0, 6)}`;
}

export interface OpenRunNodeArgs {
  store: AgentRunsStore;
  emit: RunEventSink;
  runId: string;
  ordinal: number;
  batchId?: number;
  kind: AgentRunNodeKind;
  /** Tool name / `'agent'` / `ctx.invoke` target. */
  name?: string;
  args?: unknown;
  started: number;
}

/**
 * Open a durable "running" run node (issue #158, ledger-tail hybrid) AND
 * publish `node.start` to the live bus. Returns the node id for the
 * matching `closeRunNode`. Store + sink failures are swallowed — a broken
 * ledger or wedged subscriber must never fail the handler.
 */
export function openRunNode(args: OpenRunNodeArgs): string {
  const nodeId = makeNodeId(args.runId, args.ordinal);
  const argsJson = args.args !== undefined ? (truncateForAudit(args.args) ?? '') : undefined;
  try {
    args.store.openNode({
      nodeId,
      runId: args.runId,
      ordinal: args.ordinal,
      ...(args.batchId !== undefined ? { batchId: args.batchId } : {}),
      kind: args.kind,
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(argsJson !== undefined ? { argsJson } : {}),
      startedAt: args.started,
    });
  } catch {
    /* never let audit failures bubble */
  }
  try {
    args.emit({
      type: 'node.start',
      ordinal: args.ordinal,
      ...(args.batchId !== undefined ? { batchId: args.batchId } : {}),
      kind: args.kind,
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.args !== undefined ? { args: args.args } : {}),
    });
  } catch {
    /* swallow */
  }
  return nodeId;
}

/**
 * Map a chat `usage` event (issue #158, Phase 2) onto the token/model fields
 * `closeRunNode` persists. Returns `{}` when no usage was observed (a runner
 * still on the collect-on-exit path).
 */
export function usageCloseFields(
  usage: Extract<ChatStreamEvent, { type: 'usage' }> | undefined,
): Partial<CloseRunNodeArgs> {
  if (!usage) return {};
  return {
    ...(usage.model !== undefined ? { model: usage.model } : {}),
    ...(usage.provider !== undefined ? { provider: usage.provider } : {}),
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
  };
}

export interface CloseRunNodeArgs {
  store: AgentRunsStore;
  emit: RunEventSink;
  nodeId: string;
  ordinal: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** Child run id, when a `ctx.invoke` created one (some failures abort before that). */
  childRunId?: string;
  started: number;
  ended: number;
  /**
   * Token/model rollup for an `agent` node (issue #158, Phase 2). Learned at
   * end-of-turn from the chat adapter's `usage` event; feeds `runs.total_*`.
   */
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Settle a node opened by `openRunNode`: write the outcome to the ledger
 * AND publish `node.end`. The `node.end` `result` carries the untruncated
 * value (it's ephemeral on the bus); the ledger row keeps the 64 KB-capped
 * copy.
 */
export function closeRunNode(args: CloseRunNodeArgs): void {
  const durationMs = args.ended - args.started;
  const outputJson =
    args.ok && args.result !== undefined ? (truncateForAudit(args.result) ?? '') : undefined;
  try {
    args.store.closeNode({
      nodeId: args.nodeId,
      ok: args.ok,
      ...(outputJson !== undefined ? { outputJson } : {}),
      ...(args.error !== undefined ? { error: args.error } : {}),
      ...(args.childRunId !== undefined ? { childRunId: args.childRunId } : {}),
      endedAt: args.ended,
      durationMs,
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.provider !== undefined ? { provider: args.provider } : {}),
      ...(args.inputTokens !== undefined ? { inputTokens: args.inputTokens } : {}),
      ...(args.outputTokens !== undefined ? { outputTokens: args.outputTokens } : {}),
      ...(args.cacheReadTokens !== undefined ? { cacheReadTokens: args.cacheReadTokens } : {}),
      ...(args.cacheWriteTokens !== undefined ? { cacheWriteTokens: args.cacheWriteTokens } : {}),
    });
  } catch {
    /* swallow */
  }
  try {
    args.emit({
      type: 'node.end',
      ordinal: args.ordinal,
      ok: args.ok,
      ...(args.result !== undefined ? { result: args.result } : {}),
      ...(args.error !== undefined ? { error: args.error } : {}),
      durationMs,
    });
  } catch {
    /* swallow */
  }
}
