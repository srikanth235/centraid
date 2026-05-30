/**
 * Audit-row helpers for automation handler runs (issue #80).
 *
 * Split out of `automation-handler-runner.ts` so the runner stays
 * focused on worker/message orchestration. Everything here is
 * pure-ish — the only side-effect surface is the supplied
 * `AutomationRunsStore` reference.
 */

import { randomUUID } from 'node:crypto';
import type { AutomationRunsStore, InsertNodeInput } from './automation-runs-store.js';
import type { AutomationRunRow, AutomationTriggerKind } from './automation-runs-schema.js';
import type { AutomationHistoryConfig } from './automation-manifest.js';

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

export function rowToRunRef(row: AutomationRunRow): RunRef {
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
  store: AutomationRunsStore,
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

export interface RecordToolNodeArgs {
  store: AutomationRunsStore;
  runId: string;
  ordinal: number;
  batchId?: number;
  name: string;
  args?: unknown;
  ok: boolean;
  result?: unknown;
  error?: string;
  started: number;
  ended: number;
}

export function recordToolNode(args: RecordToolNodeArgs): void {
  const input: InsertNodeInput = {
    nodeId: makeNodeId(args.runId, args.ordinal),
    runId: args.runId,
    ordinal: args.ordinal,
    ...(args.batchId !== undefined ? { batchId: args.batchId } : {}),
    kind: 'tool',
    name: args.name,
    ...(args.args !== undefined ? { argsJson: truncateForAudit(args.args) ?? '' } : {}),
    ...(args.ok && args.result !== undefined
      ? { outputJson: truncateForAudit(args.result) ?? '' }
      : {}),
    ok: args.ok,
    ...(args.error ? { error: args.error } : {}),
    startedAt: args.started,
    endedAt: args.ended,
    durationMs: args.ended - args.started,
  };
  try {
    args.store.insertNode(input);
  } catch {
    /* never let audit failures bubble */
  }
}

export interface RecordAgentNodeArgs {
  store: AutomationRunsStore;
  runId: string;
  ordinal: number;
  prompt: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  started: number;
  ended: number;
}

export function recordAgentNode(args: RecordAgentNodeArgs): void {
  const input: InsertNodeInput = {
    nodeId: makeNodeId(args.runId, args.ordinal),
    runId: args.runId,
    ordinal: args.ordinal,
    kind: 'agent',
    name: 'agent',
    argsJson: truncateForAudit({ prompt: args.prompt }) ?? '',
    ...(args.ok && args.result !== undefined
      ? { outputJson: truncateForAudit(args.result) ?? '' }
      : {}),
    ok: args.ok,
    ...(args.error ? { error: args.error } : {}),
    startedAt: args.started,
    endedAt: args.ended,
    durationMs: args.ended - args.started,
  };
  try {
    args.store.insertNode(input);
  } catch {
    /* swallow */
  }
}

export interface RecordInvokeNodeArgs {
  store: AutomationRunsStore;
  runId: string;
  ordinal: number;
  /** The `ctx.invoke` target — `"name"` intra-app or `"appId/name"` cross-app. */
  target: string;
  input?: unknown;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** Child run id, when the child run was created (some failures abort before that). */
  childRunId?: string;
  started: number;
  ended: number;
}

/**
 * Record a `ctx.invoke` call as a `kind: 'invoke'` audit node. The
 * `childRunId` links it to the spawned run so the DAG view can nest the
 * child timeline.
 */
export function recordInvokeNode(args: RecordInvokeNodeArgs): void {
  const node: InsertNodeInput = {
    nodeId: makeNodeId(args.runId, args.ordinal),
    runId: args.runId,
    ordinal: args.ordinal,
    kind: 'invoke',
    name: args.target,
    ...(args.input !== undefined ? { argsJson: truncateForAudit(args.input) ?? '' } : {}),
    ...(args.ok && args.result !== undefined
      ? { outputJson: truncateForAudit(args.result) ?? '' }
      : {}),
    ok: args.ok,
    ...(args.error ? { error: args.error } : {}),
    ...(args.childRunId ? { childRunId: args.childRunId } : {}),
    startedAt: args.started,
    endedAt: args.ended,
    durationMs: args.ended - args.started,
  };
  try {
    args.store.insertNode(node);
  } catch {
    /* swallow */
  }
}
