/**
 * Parent-side handlers for the worker's `ctx.*` messages (issue #80).
 *
 * Split out of `runner.ts` so the runner stays focused
 * on worker lifecycle + message routing. Each function here takes the
 * audit `AgentRunsStore` (when present) and returns a reply that
 * matches the worker's expected wire shape.
 */

import type { AgentDispatcher, DispatchContext, ToolDispatcher, ToolResult } from './runner.js';
import type {
  ConversationStore,
  TurnStreamEvent,
  VaultBridge,
  VaultOp,
} from '@centraid/app-engine';
import {
  closeRunNode,
  openRunNode,
  rowToRunRef,
  usageCloseFields,
  type RunEventSink,
} from './audit.js';

export interface ToolCallWire {
  name: string;
  args: unknown;
}

export interface AuditState {
  store: ConversationStore;
  runId: string;
  automationId: string;
  ordinal: number;
  nextBatchId: number;
  /** Live run-stream sink. No-op until the host wires its bus (issue #158). */
  emit: RunEventSink;
}

export function nextOrdinal(audit: AuditState): number {
  return audit.ordinal++;
}

export function nextBatchIdFor(audit: AuditState, n: number): number | undefined {
  if (n <= 1) return undefined;
  return audit.nextBatchId++;
}

export interface DispatchBatchArgs {
  audit: AuditState;
  toolDispatcher: ToolDispatcher;
  dispatchCtx: DispatchContext;
  calls: ToolCallWire[];
}

/**
 * Dispatch one batch of `ctx.tool` calls and record each as a
 * `run_nodes` row. There is no runtime retry — a failed `ctx.tool`
 * rejects the handler's Promise, and the handler (which is plain JS)
 * owns retry/backoff/error-classification via `try/catch`. See the
 * "Run audit & state" block of the builder system prompt.
 */
export async function dispatchToolBatch(args: DispatchBatchArgs): Promise<ToolResult[]> {
  const { audit, calls, toolDispatcher, dispatchCtx } = args;
  const ordinals = calls.map(() => nextOrdinal(audit));
  const batchId = nextBatchIdFor(audit, calls.length);
  const started = Date.now();

  // Open every node (durable "running" row + `node.start`) BEFORE the batch
  // dispatches, so the parallel lane shows all calls in flight at once.
  const nodeIds = calls.map((call, i) =>
    openRunNode({
      store: audit.store,
      emit: audit.emit,
      runId: audit.runId,
      ordinal: ordinals[i]!,
      ...(batchId !== undefined ? { batchId } : {}),
      kind: 'tool',
      name: call.name,
      args: call.args,
      started,
    }),
  );
  let results: ToolResult[];
  try {
    results = await toolDispatcher(
      calls.map((c) => ({ name: c.name, args: c.args })),
      dispatchCtx,
    );
  } catch (err) {
    // The dispatcher rejected wholesale (e.g. CLI spawn blew up). The runner's
    // catch turns this into failed tool replies and the run keeps going — so if
    // we don't settle the nodes here they'd stay `ended_at = NULL` forever and
    // the live stream would never see them terminate. Close every opened node
    // as failed (durable close + `node.end`), then rethrow so the runner still
    // sends its per-call failure replies to the worker.
    const ended = Date.now();
    const error = err instanceof Error ? err.message : String(err);
    for (let i = 0; i < nodeIds.length; i++) {
      closeRunNode({
        store: audit.store,
        emit: audit.emit,
        nodeId: nodeIds[i]!,
        ordinal: ordinals[i]!,
        ok: false,
        error,
        started,
        ended,
      });
    }
    throw err;
  }
  const ended = Date.now();
  return calls.map((_call, i) => {
    const result = results[i] ?? { ok: false, error: 'no result returned by dispatcher' };
    // Phase 3 (issue #158): prefer the dispatcher's real per-tool window when
    // it reported one (mock onToolStart/onToolResults); else the batch span.
    closeRunNode({
      store: audit.store,
      emit: audit.emit,
      nodeId: nodeIds[i]!,
      ordinal: ordinals[i]!,
      ok: result.ok,
      ...(result.result !== undefined ? { result: result.result } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
      started: result.startedAt ?? started,
      ended: result.endedAt ?? ended,
    });
    return result;
  });
}

export interface CtxReply {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Service one `ctx.agent` call: open an `agent` run node, dispatch, forward
 * streamed chat events as `node.delta`, and settle the node with the
 * token/model rollup. Returns the reply the runner sends back to the worker.
 * Extracted from the runner so each file stays under the repo-hygiene line
 * cap (issue #166).
 */
export async function handleAgentMessage(
  audit: AuditState,
  dispatchCtx: DispatchContext,
  agentDispatcher: AgentDispatcher,
  prompt: string,
  json: unknown,
): Promise<CtxReply> {
  const ordinal = nextOrdinal(audit);
  const started = Date.now();

  const nodeId = openRunNode({
    store: audit.store,
    emit: audit.emit,
    runId: audit.runId,
    ordinal,
    kind: 'agent',
    name: 'agent',
    args: { prompt },
    started,
  });
  // When the runner streams (issue #158, Phase 2), forward each chat event as a
  // `node.delta` on this agent node, and remember the last `usage` event so
  // `closeRunNode` can persist the token/model rollup.
  let lastUsage: Extract<TurnStreamEvent, { type: 'usage' }> | undefined;
  const onEvent = (ev: TurnStreamEvent): void => {
    if (ev.type === 'usage') lastUsage = ev;
    try {
      audit.emit({ type: 'node.delta', ordinal, event: ev });
    } catch {
      /* swallow */
    }
  };
  try {
    const result = await agentDispatcher({ prompt, json, onEvent }, dispatchCtx);
    closeRunNode({
      store: audit.store,
      emit: audit.emit,
      nodeId,
      ordinal,
      ok: true,
      result,
      started,
      ended: Date.now(),
      ...usageCloseFields(lastUsage),
    });
    return { ok: true, result };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    closeRunNode({
      store: audit.store,
      emit: audit.emit,
      nodeId,
      ordinal,
      ok: false,
      error,
      started,
      ended: Date.now(),
      ...usageCloseFields(lastUsage),
    });
    return { ok: false, error };
  }
}

/**
 * Service one `ctx.vault` call: open a `tool` run node named `vault.<op>`,
 * proxy through the host-injected bridge (the automation's enrolled
 * `agent.agent` credential lives host-side), and settle the node.
 *
 * Replay safety: an `invoke` without a caller-supplied `invocationId` gets a
 * deterministic one derived from the run id + the node's ordinal. Re-firing
 * the same runId replays the recorded outcome inside the vault instead of
 * double-executing — the handler lint already guarantees the call sequence
 * is deterministic.
 *
 * Without a bridge every call fails closed with `VAULT_UNAVAILABLE`,
 * mirroring app handlers on gateways that mount no vault plane.
 */
export async function handleVaultMessage(
  audit: AuditState,
  vault: VaultBridge | undefined,
  op: VaultOp,
  payload: Record<string, unknown>,
): Promise<CtxReply & { code?: string }> {
  const ordinal = nextOrdinal(audit);
  const started = Date.now();
  let effective = payload;
  if (op === 'invoke' && typeof effective.invocationId !== 'string') {
    effective = { ...effective, invocationId: `${audit.runId}:v${ordinal}` };
  }
  const nodeId = openRunNode({
    store: audit.store,
    emit: audit.emit,
    runId: audit.runId,
    ordinal,
    kind: 'tool',
    name: `vault.${op}`,
    args: effective,
    started,
  });
  const settle = (reply: CtxReply & { code?: string }): CtxReply & { code?: string } => {
    closeRunNode({
      store: audit.store,
      emit: audit.emit,
      nodeId,
      ordinal,
      ok: reply.ok,
      ...(reply.result !== undefined ? { result: reply.result } : {}),
      ...(reply.error !== undefined ? { error: reply.error } : {}),
      started,
      ended: Date.now(),
    });
    return reply;
  };
  if (!vault) {
    return settle({
      ok: false,
      code: 'VAULT_UNAVAILABLE',
      error: 'this automation has no vault surface — the host mounted no vault plane',
    });
  }
  try {
    const result = await vault({ op, payload: effective });
    if (!result.ok) {
      return settle({
        ok: false,
        ...(result.code ? { code: result.code } : {}),
        error: result.error ?? 'vault call failed',
      });
    }
    return settle({ ok: true, result: result.result });
  } catch (err) {
    return settle({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export function handleStateMessage(
  audit: AuditState,
  method: 'get' | 'set' | 'delete',
  key: string,
  value: unknown,
): CtxReply {
  try {
    if (method === 'get') {
      const entry = audit.store.stateGet(audit.automationId, key);
      if (!entry) return { ok: true, result: undefined };
      try {
        return { ok: true, result: JSON.parse(entry.valueJson) as unknown };
      } catch {
        return { ok: true, result: entry.valueJson };
      }
    }
    if (method === 'set') {
      const json = JSON.stringify(value === undefined ? null : value);
      audit.store.stateSet(audit.automationId, key, json, Date.now());
      return { ok: true };
    }
    if (method === 'delete') {
      audit.store.stateDelete(audit.automationId, key);
      return { ok: true };
    }
    return { ok: false, error: `unknown state method: ${String(method)}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function handleRunsMessage(
  audit: AuditState,
  method: 'last' | 'list',
  filter: { automationId?: string; status?: 'ok' | 'error'; since?: number; limit?: number },
): CtxReply {
  try {
    // An automation's runs are its execution conversations, grouped by the
    // automation ref (each fire is its own conversation now).
    const automationRef = filter.automationId ?? audit.automationId;
    const limit = filter.limit ?? 50;
    // Fetch one extra row so we can drop the in-progress self-turn without
    // short-changing the caller's limit.
    const rows = audit.store
      .listAutomationTurns(automationRef, {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.since !== undefined ? { since: filter.since } : {}),
        limit: limit + 1,
      })
      .filter((r) => r.turnId !== audit.runId)
      .slice(0, limit);
    const toRef = (r: (typeof rows)[number]): ReturnType<typeof rowToRunRef> =>
      rowToRunRef(r, automationRef, audit.store.messageInText(r.turnId));
    if (method === 'last') {
      const first = rows[0];
      return { ok: true, result: first ? toRef(first) : undefined };
    }
    return { ok: true, result: rows.map(toRef) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
