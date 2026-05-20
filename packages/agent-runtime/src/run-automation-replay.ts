/*
 * Replay dispatchers for pinned-data builder iteration (issue #80
 * follow-up).
 *
 * While iterating on an automation handler, re-running it against live
 * tools (GitHub, Linear, …) every time is slow and non-deterministic.
 * The fix: pin a known-good run, then fire the automation with
 * `triggerKind: 'replay'` so `ctx.tool` / `ctx.agent` / `ctx.invoke`
 * are served from the pinned run's recorded `run_nodes` instead of
 * spawning CLIs.
 *
 * Matching is by call name + serialized args, falling back to name-only
 * order — so a handler edit that reorders or tweaks unrelated calls
 * still replays cleanly. Recorded nodes are consumed at most once; a
 * call with no matching recorded node fails loudly (the pin is stale —
 * re-pin against a fresh live run).
 */

import type {
  AutomationAgentCall,
  AutomationAgentDispatcher,
  AutomationInvokeDispatcher,
  AutomationRunNodeRow,
  AutomationRunsStore,
  AutomationToolCall,
  AutomationToolDispatcher,
  AutomationToolResult,
} from '@centraid/runtime-core';

export interface ReplayDispatchers {
  toolDispatcher: AutomationToolDispatcher;
  agentDispatcher: AutomationAgentDispatcher;
  invokeDispatcher: AutomationInvokeDispatcher;
}

function parseJson(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * Build the three replay dispatchers from a pinned run's recorded nodes.
 * Every dispatcher reads from the same consumed-node set so interleaved
 * tool / agent / invoke calls all advance the same cursor.
 */
export function buildReplayDispatchers(
  store: AutomationRunsStore,
  fromRunId: string,
): ReplayDispatchers {
  const nodes = store.listNodes(fromRunId);
  const consumed = new Set<string>();

  /**
   * Take the next unconsumed recorded node matching `kind` + `name`,
   * preferring an exact serialized-args match (so repeated calls to the
   * same target with different payloads replay the right node), else the
   * earliest by order. A `kind`+`name` miss returns `undefined` — the
   * caller fails loudly rather than serving an unrelated node's output.
   */
  const take = (
    kind: AutomationRunNodeRow['kind'],
    name: string,
    argsJson: string | undefined,
  ): AutomationRunNodeRow | undefined => {
    const candidates = nodes.filter(
      (n) => n.kind === kind && n.name === name && !consumed.has(n.nodeId),
    );
    const picked =
      (argsJson !== undefined ? candidates.find((n) => n.argsJson === argsJson) : undefined) ??
      candidates[0];
    if (picked) consumed.add(picked.nodeId);
    return picked;
  };

  const toolDispatcher: AutomationToolDispatcher = (calls: readonly AutomationToolCall[]) => {
    const results: AutomationToolResult[] = calls.map((call) => {
      const argsJson = call.args === undefined ? undefined : safeStringify(call.args);
      const node = take('tool', call.name, argsJson);
      if (!node) {
        return {
          ok: false,
          error: `replay: no pinned result for ctx.tool("${call.name}") — re-pin against a fresh live run`,
        };
      }
      if (!node.ok) return { ok: false, error: node.error ?? 'replay: pinned call failed' };
      return { ok: true, result: parseJson(node.outputJson) };
    });
    return Promise.resolve(results);
  };

  const agentDispatcher: AutomationAgentDispatcher = (call: AutomationAgentCall) => {
    const node = take('agent', 'agent', safeStringify({ prompt: call.prompt }));
    if (!node) {
      return Promise.reject(
        new Error('replay: no pinned result for ctx.agent — re-pin against a fresh live run'),
      );
    }
    if (!node.ok)
      return Promise.reject(new Error(node.error ?? 'replay: pinned agent call failed'));
    return Promise.resolve(parseJson(node.outputJson));
  };

  const invokeDispatcher: AutomationInvokeDispatcher = (name, args) => {
    // Match on the serialized input so repeated invokes of the same
    // target with different payloads replay their own recorded child.
    const node = take(
      'invoke',
      name,
      args.input === undefined ? undefined : safeStringify(args.input),
    );
    if (!node) {
      return Promise.reject(
        new Error(
          `replay: no pinned result for ctx.invoke("${name}") — re-pin against a fresh live run`,
        ),
      );
    }
    if (!node.ok) {
      const err = new Error(
        node.error ?? `replay: pinned ctx.invoke("${name}") failed`,
      ) as Error & {
        childRunId?: string;
      };
      if (node.childRunId) err.childRunId = node.childRunId;
      return Promise.reject(err);
    }
    return Promise.resolve({
      output: parseJson(node.outputJson),
      ...(node.childRunId ? { childRunId: node.childRunId } : {}),
    });
  };

  return { toolDispatcher, agentDispatcher, invokeDispatcher };
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
