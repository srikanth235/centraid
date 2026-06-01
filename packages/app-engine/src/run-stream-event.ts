/*
 * Live automation-run stream events (issue #158).
 *
 * Automations run on the same agent engines as chat, but their runs were
 * not streamed — `run-now` detached and the viewer polled the ledger.
 * This is the event union that streams a run end-to-end, with **full chat
 * parity**: a node's token-level activity is carried as chat's own
 * `ChatStreamEvent`, nested under the owning run node.
 *
 * Ledger-tail hybrid (the durability contract):
 *   - `run.start` / `node.start` / `node.end` / `run.end` mirror durable
 *     `run_nodes` lifecycle — they are persisted (the ledger stays the
 *     source of truth) and replayable. A viewer that joins late replays
 *     them from the ledger, then goes live.
 *   - `node.delta` is **ephemeral** — token-granular chat events that ride
 *     the in-process bus only, never persisted. (Emitted from Phase 2 on,
 *     once `ctx.agent` routes through the chat adapters.)
 *
 * The transport (bus + SSE) is runner-agnostic and parent-side; only the
 * `ctx.agent` source of `node.delta` differs per runner.
 */

import type { ChatStreamEvent } from './chat-runner.js';
import type { AgentRunNodeKind } from './agent-runs-schema.js';

export type RunStreamEvent =
  | { type: 'run.start'; runId: string }
  | {
      type: 'node.start';
      ordinal: number;
      /** Set when the node is part of a parallel batch (≥2 `ctx.tool` calls). */
      batchId?: number;
      kind: AgentRunNodeKind;
      /** Tool name / `'agent'` / `ctx.invoke` target. */
      name?: string;
      args?: unknown;
    }
  /** Token-level chat event, nested under run node `ordinal`. Ephemeral. */
  | { type: 'node.delta'; ordinal: number; event: ChatStreamEvent }
  | {
      type: 'node.end';
      ordinal: number;
      ok: boolean;
      result?: unknown;
      error?: string;
      durationMs: number;
    }
  | { type: 'run.end'; ok: boolean; error?: string };
