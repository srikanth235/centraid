/*
 * Host-agnostic persistent mock-LLM session (issue #166).
 *
 * The token-free side of the automation runtime: one long-lived agent session
 * per fire, puppeted by the mock provider, that executes every `ctx.tool`
 * batch. The deterministic handler drives; each batch is staged into the live
 * session; the agent executes the tools through its native tool/MCP/auth
 * machinery and returns `tool_result` blocks; the session exits only when the
 * driver stages a final `end_turn`. No real model is ever contacted on this
 * path — it is ~0 real tokens by construction.
 *
 * The ONE thing that varies per host is how the agent is pointed at the mock —
 * a `driveAgent` callback that runs the host's agent against the mock's base
 * URL + bearer (an in-process Claude SDK turn or a `codex exec` subprocess for
 * the local runner, an embedded `runEmbeddedAgent` run for OpenClaw).
 * Everything else — the mock
 * server, the single dispatch id, batch staging/correlation, per-call timing,
 * and teardown — is shared here so codex, claude, and OpenClaw run the exact
 * same runtime (the issue's central goal). Lives in app-engine-adjacent
 * `@centraid/automation` so both the CLI host (agent-runtime) and the in-process
 * host (openclaw-plugin) can import it without either depending on the other.
 */

import { randomUUID } from 'node:crypto';
import { startMockLlmServer, type StagedTurn } from './mock-llm-server.js';
import type { DispatchContext, ToolCall, ToolDispatcher, ToolResult } from '../handler/runner.js';

/** What a host's `driveAgent` is handed to run the agent against the mock. */
export interface AgentDriveInput {
  /** Mock-LLM base URL (`http://127.0.0.1:<port>/v1`). */
  readonly mockBaseUrl: string;
  /** Per-session bearer token (`centraid-mock-<dispatchId>`). */
  readonly mockBearerToken: string;
  /** The session prompt that puts the agent in tool-executor mode. */
  readonly prompt: string;
  /** Workspace dir the agent should treat as cwd. */
  readonly cwd: string;
  /** Fires on timeout / cancel — the driver must stop the agent. */
  readonly abortSignal: AbortSignal;
}

/** Outcome of one agent session run (resolves when the session ends). */
export interface AgentDriveResult {
  readonly ok: boolean;
  /** Failure detail, surfaced on any batch still awaiting when the agent died. */
  readonly error?: string;
}

/** Run the host's agent against the mock for the lifetime of one fire. */
export type AgentDriver = (input: AgentDriveInput) => Promise<AgentDriveResult>;

export interface PersistentMockSessionOptions {
  /** Workspace dir handed to `driveAgent` as cwd. */
  readonly workdir: string;
  /** Id of the automation being fired (embedded in the session prompt). */
  readonly automationId: string;
  /** Host adapter: run the agent against the mock. */
  readonly driveAgent: AgentDriver;
  readonly onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export interface PersistentMockSession {
  /** Stage one `ctx.tool` batch into the live session and read its results. */
  readonly toolDispatcher: ToolDispatcher;
  /** End the session (final `end_turn`), drain the agent, stop the mock. */
  close(): Promise<void>;
}

/**
 * Compose the persistent session prompt. The mock dictates every turn, so the
 * content barely matters — but a clear instruction keeps the agent in
 * "execute the staged tool, return its result, await the next" mode.
 */
function buildSessionPrompt(automationId: string): string {
  return (
    `<<<centraid:${automationId}>>>\n` +
    'You are the deterministic tool executor for a centraid automation. ' +
    'Execute each staged tool call exactly as given and return its tool_result. ' +
    'Do not improvise, add tools, or stop early — continue until told the run is complete.'
  );
}

/** Convert worker tool calls into the StagedTurn shape the mock returns. */
function batchToStagedTurn(calls: readonly ToolCall[]): StagedTurn {
  return {
    stopReason: 'tool_use',
    toolUses: calls.map((c, idx) => ({
      id: `toolu_${idx}_${randomUUID().slice(0, 8)}`,
      name: c.name,
      input: c.args,
    })),
  };
}

/** One captured tool result as the mock surfaces it. */
type CapturedResult = { id: string; content: string; isError: boolean };

/** What a parked `toolDispatcher` is woken with: results, or a dead session. */
type BatchOutcome =
  | { kind: 'results'; results: ReadonlyArray<CapturedResult> }
  | { kind: 'exit'; outcome: AgentDriveResult };

const exitError = (outcome: AgentDriveResult): string =>
  `agent session ended before returning tool results${outcome.error ? `: ${outcome.error}` : ''}`;

/** Race `promise` against an `ms` deadline; clears the timer the moment the
 *  promise wins so a finished run leaves no dangling timeout. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    let settled = false;
    const settle = (v: T | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const timer = setTimeout(() => settle(undefined), ms);
    void promise.then(
      (v) => {
        clearTimeout(timer);
        settle(v);
      },
      () => {
        clearTimeout(timer);
        settle(undefined);
      },
    );
  });
}

/**
 * Stand up the persistent mock session. The agent session itself is started
 * lazily on the first `ctx.tool` batch (an automation that never calls a tool
 * never starts one). Returns the `toolDispatcher` and a `close()` that ends
 * the session and stops the mock.
 */
export async function startPersistentMockSession(
  opts: PersistentMockSessionOptions,
): Promise<PersistentMockSession> {
  interface BatchAwaiter {
    settle(outcome: BatchOutcome): void;
  }
  // Single persistent dispatch → at most one outstanding batch awaiter at a
  // time (the handler awaits each `ctx.tool` before the next).
  const batchAwaiters = new Map<string, BatchAwaiter>();

  // Per-call timing (issue #158): the mock signals when it hands the agent a
  // tool (start) and when each result lands (finish). Tool-use ids are globally
  // unique, so a flat id→window map serves the whole session.
  const toolTiming = new Map<string, { startedAt?: number; endedAt?: number }>();
  const timingFor = (id: string): { startedAt?: number; endedAt?: number } => {
    let entry = toolTiming.get(id);
    if (!entry) {
      entry = {};
      toolTiming.set(id, entry);
    }
    return entry;
  };

  const mock = await startMockLlmServer({
    ...(opts.onLog ? { onLog: opts.onLog } : {}),
    onToolStart: (_dispatchId, toolUses) => {
      const now = Date.now();
      for (const u of toolUses) timingFor(u.id).startedAt = now;
    },
    onToolResults: (dispatchId, results) => {
      const now = Date.now();
      for (const r of results) timingFor(r.id).endedAt = now;
      const pending = batchAwaiters.get(dispatchId);
      if (pending) pending.settle({ kind: 'results', results });
    },
  });

  interface Session {
    dispatchId: string;
    drive: Promise<AgentDriveResult>;
    exited: AgentDriveResult | undefined;
  }
  let session: Session | undefined;

  const ensureSession = (ctx: DispatchContext): Session => {
    if (session) return session;
    const { dispatchId, bearerToken } = mock.mintDispatchToken();
    const drive = opts.driveAgent({
      mockBaseUrl: mock.baseUrl,
      mockBearerToken: bearerToken,
      prompt: buildSessionPrompt(opts.automationId),
      cwd: opts.workdir,
      abortSignal: ctx.abortSignal,
    });
    const s: Session = { dispatchId, drive, exited: undefined };
    // If the session dies (crash/abort) while a batch is parked, wake the
    // awaiter so the handler sees a failure instead of hanging forever.
    void drive.then((outcome) => {
      s.exited = outcome;
      const pending = batchAwaiters.get(dispatchId);
      if (pending) pending.settle({ kind: 'exit', outcome });
    });
    session = s;
    return s;
  };

  const toolDispatcher: ToolDispatcher = async (
    calls: readonly ToolCall[],
    ctx: DispatchContext,
  ): Promise<ToolResult[]> => {
    const s = ensureSession(ctx);
    if (s.exited) {
      return calls.map(() => ({ ok: false, error: exitError(s.exited!) }));
    }
    const turn = batchToStagedTurn(calls);

    // Register the awaiter BEFORE staging: staging releases the parked agent
    // request, which may deliver results almost immediately.
    const outcomePromise = new Promise<BatchOutcome>((resolve) => {
      batchAwaiters.set(s.dispatchId, {
        settle(outcome) {
          batchAwaiters.delete(s.dispatchId);
          resolve(outcome);
        },
      });
    });
    mock.stageTurn(s.dispatchId, turn);

    const outcome = await outcomePromise;
    if (outcome.kind === 'exit') {
      return calls.map(() => ({ ok: false, error: exitError(outcome.outcome) }));
    }

    const turnUses = turn.toolUses ?? [];
    const byIdx = new Map<number, { content: string; isError: boolean }>();
    for (const r of outcome.results) {
      const useIdx = turnUses.findIndex((u) => u.id === r.id);
      if (useIdx >= 0) byIdx.set(useIdx, { content: r.content, isError: r.isError });
    }
    const timing = (idx: number): { startedAt?: number; endedAt?: number } => {
      const t = toolTiming.get(turnUses[idx]?.id ?? '');
      return {
        ...(t?.startedAt !== undefined ? { startedAt: t.startedAt } : {}),
        ...(t?.endedAt !== undefined ? { endedAt: t.endedAt } : {}),
      };
    };
    return calls.map((_call, idx) => {
      const r = byIdx.get(idx);
      if (!r) return { ok: false, error: 'no tool_result returned by host agent' };
      if (r.isError) return { ok: false, error: r.content, ...timing(idx) };
      try {
        return { ok: true, result: JSON.parse(r.content) as unknown, ...timing(idx) };
      } catch {
        return { ok: true, result: r.content, ...timing(idx) };
      }
    });
  };

  let closed = false;
  return {
    toolDispatcher,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // End the session: stage a final `end_turn` so the agent finishes and
      // exits, then wait (bounded) for it to drain. `mock.close()` releases any
      // straggler parked request afterwards.
      if (session && !session.exited) {
        try {
          mock.stageTurn(session.dispatchId, { text: '', stopReason: 'end_turn' });
        } catch {
          /* a turn may already be buffered; mock.close() will release it */
        }
        await withDeadline(session.drive, 5000);
      }
      await mock.close().catch(() => undefined);
    },
  };
}
