/**
 * Parent-side handlers for the worker's `ctx.*` messages (issue #80).
 *
 * Split out of `automation-handler-runner.ts` so the runner stays focused
 * on worker lifecycle + message routing. Each function here takes the
 * audit `AgentRunsStore` (when present) and returns a reply that
 * matches the worker's expected wire shape.
 */

import type {
  AutomationAgentDispatcher,
  AutomationDispatchContext,
  AutomationInvokeDispatcher,
  AutomationToolDispatcher,
  AutomationToolResult,
} from './automation-handler-runner.js';
import type { AgentRunsStore, ChatStreamEvent } from '@centraid/app-engine';
import {
  closeRunNode,
  openRunNode,
  rowToRunRef,
  usageCloseFields,
  type RunEventSink,
} from './automation-handler-audit.js';
import type { RunJournal } from './automation-handler-journal.js';

export interface ToolCallWire {
  name: string;
  args: unknown;
}

export interface AuditState {
  store: AgentRunsStore;
  runId: string;
  automationId: string;
  ordinal: number;
  nextBatchId: number;
  /** Live run-stream sink. No-op until the host wires its bus (issue #158). */
  emit: RunEventSink;
  /**
   * Journal of a prior run replayed on resume (issue #166, Phase 3). Empty
   * for a fresh fire; on resume it serves recorded `ctx.tool`/`ctx.agent`/
   * `ctx.invoke` results so already-done work is not re-dispatched.
   */
  journal: RunJournal;
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
  toolDispatcher: AutomationToolDispatcher;
  dispatchCtx: AutomationDispatchContext;
  calls: ToolCallWire[];
}

/**
 * Dispatch one batch of `ctx.tool` calls and record each as a
 * `run_nodes` row. There is no runtime retry — a failed `ctx.tool`
 * rejects the handler's Promise, and the handler (which is plain JS)
 * owns retry/backoff/error-classification via `try/catch`. See the
 * "Run audit & state" block of the builder system prompt.
 */
export async function dispatchToolBatch(args: DispatchBatchArgs): Promise<AutomationToolResult[]> {
  const { audit, calls, toolDispatcher, dispatchCtx } = args;
  const ordinals = calls.map(() => nextOrdinal(audit));
  const batchId = nextBatchIdFor(audit, calls.length);
  const started = Date.now();

  // Resume replay (issue #166, Phase 3): if every call in this batch has a
  // settled, successful journal entry from the prior run, serve the recorded
  // results without re-dispatching — no CLI session, no tool side-effects.
  // A partially-journaled batch (the crash landed mid-batch) re-runs whole.
  const replay = ordinals.map((o) => audit.journal.replayable(o));
  if (replay.length > 0 && replay.every((e) => e !== undefined)) {
    return calls.map((call, i) => {
      const ended = Date.now();
      const result: AutomationToolResult = { ok: true, result: replay[i]!.output };
      const nodeId = openRunNode({
        store: audit.store,
        emit: audit.emit,
        runId: audit.runId,
        ordinal: ordinals[i]!,
        ...(batchId !== undefined ? { batchId } : {}),
        kind: 'tool',
        name: call.name,
        args: call.args,
        started,
      });
      closeRunNode({
        store: audit.store,
        emit: audit.emit,
        nodeId,
        ordinal: ordinals[i]!,
        ok: true,
        result: replay[i]!.output,
        started,
        ended,
      });
      return result;
    });
  }
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
  let results: AutomationToolResult[];
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
 * Service one `ctx.agent` call: open an `agent` run node, dispatch (or replay
 * from the resume journal), forward streamed chat events as `node.delta`, and
 * settle the node with the token/model rollup. Returns the reply the runner
 * sends back to the worker. Extracted from the runner so each file stays under
 * the repo-hygiene line cap (issue #166).
 */
export async function handleAgentMessage(
  audit: AuditState,
  dispatchCtx: AutomationDispatchContext,
  agentDispatcher: AutomationAgentDispatcher,
  prompt: string,
  json: unknown,
): Promise<CtxReply> {
  const ordinal = nextOrdinal(audit);
  const started = Date.now();

  // Resume replay (issue #166, Phase 3): a journaled `ctx.agent` call returns
  // its recorded answer WITHOUT touching the real provider — the billed
  // inference is never paid twice. Recorded as a fresh node so this run is
  // itself a complete journal for a later resume.
  const replayed = audit.journal.replayable(ordinal);
  if (replayed) {
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
    closeRunNode({
      store: audit.store,
      emit: audit.emit,
      nodeId,
      ordinal,
      ok: true,
      result: replayed.output,
      started,
      ended: Date.now(),
    });
    return { ok: true, result: replayed.output };
  }

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
  let lastUsage: Extract<ChatStreamEvent, { type: 'usage' }> | undefined;
  const onEvent = (ev: ChatStreamEvent): void => {
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
    const automationId = filter.automationId ?? audit.automationId;
    const limit = filter.limit ?? 50;
    // Fetch one extra row so we can drop the in-progress self-run without
    // short-changing the caller's limit.
    const rows = audit.store
      .listRuns({
        automationId,
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.since !== undefined ? { since: filter.since } : {}),
        limit: limit + 1,
      })
      .filter((r) => r.runId !== audit.runId)
      .slice(0, limit);
    if (method === 'last') {
      const first = rows[0];
      return { ok: true, result: first ? rowToRunRef(first) : undefined };
    }
    return { ok: true, result: rows.map(rowToRunRef) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleInvokeMessage(
  audit: AuditState,
  dispatchCtx: AutomationDispatchContext,
  invokeDispatcher: AutomationInvokeDispatcher | undefined,
  name: string,
  input: unknown,
): Promise<CtxReply> {
  if (!invokeDispatcher) {
    return { ok: false, error: 'ctx.invoke is not wired by the host runtime' };
  }
  const ordinal = nextOrdinal(audit);
  const started = Date.now();

  // Resume replay (issue #166, Phase 3): a journaled child invocation returns
  // its recorded output without re-firing the child automation.
  const replayed = audit.journal.replayable(ordinal);
  if (replayed) {
    const nodeId = openRunNode({
      store: audit.store,
      emit: audit.emit,
      runId: audit.runId,
      ordinal,
      kind: 'invoke',
      name,
      args: input,
      started,
    });
    closeRunNode({
      store: audit.store,
      emit: audit.emit,
      nodeId,
      ordinal,
      ok: true,
      result: replayed.output,
      started,
      ended: Date.now(),
    });
    return { ok: true, result: replayed.output };
  }

  const nodeId = openRunNode({
    store: audit.store,
    emit: audit.emit,
    runId: audit.runId,
    ordinal,
    kind: 'invoke',
    name,
    args: input,
    started,
  });
  try {
    const res = await invokeDispatcher(name, { input, parentRunId: audit.runId }, dispatchCtx);
    closeRunNode({
      store: audit.store,
      emit: audit.emit,
      nodeId,
      ordinal,
      ok: true,
      result: res.output,
      ...(res.childRunId ? { childRunId: res.childRunId } : {}),
      started,
      ended: Date.now(),
    });
    return { ok: true, result: res.output };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const tagged = err as { childRunId?: unknown };
    const childRunId = typeof tagged.childRunId === 'string' ? tagged.childRunId : undefined;
    closeRunNode({
      store: audit.store,
      emit: audit.emit,
      nodeId,
      ordinal,
      ok: false,
      error,
      ...(childRunId ? { childRunId } : {}),
      started,
      ended: Date.now(),
    });
    return { ok: false, error };
  }
}
