/*
 * Host-agnostic chat-runner interface.
 *
 * The per-app chat endpoint (`POST /centraid/<appId>/_turn`) delegates the
 * actual model turn to a host-injected `ConversationRunner`. Two implementations
 * exist today:
 *
 *   - `@centraid/agent-runtime`'s `makeConversationRunner` — drives codex
 *     app-server / Claude SDK locally; hosts thread the vault-register
 *     tools (`vault_sql` / `vault_invoke`) in per turn.
 *   - the gateway's `makeUnifiedConversationRunner` — the same core, plus
 *     draft-worktree file tools for builder chat.
 *
 * Either way, the route handler in app-engine never implements a model
 * loop itself; it just translates the runner's `TurnStreamEvent`s into SSE
 * frames and pipes them back to the harness client.
 */

import type { ConversationWorkspaceKind, RunKind } from './schema.js';
import type { AdapterUsageSnapshot, RunnerKind, TurnAttachment } from './turn.js';

export type AgentFailureClass =
  | 'spawn'
  | 'auth'
  | 'init'
  | 'timeout'
  | 'quota'
  | 'wedge'
  | 'exit'
  | 'unknown';

/**
 * Normalized stream events both adapters emit. The route handler translates
 * each event into one SSE frame; the harness consumes the SSE stream.
 *
 * Discriminated on `type`. Adapters are free to emit a subset — the
 * harness handles unknown event types gracefully and ignores them.
 */
export type TurnStreamEvent =
  | { type: 'assistant.start' }
  | { type: 'assistant.delta'; delta: string }
  | { type: 'reasoning.delta'; delta: string }
  /**
   * Latest per-ACP-session context-window snapshot. `used` may decrease after
   * agent-side compaction; clients must render the latest value, not a max.
   */
  | { type: 'context'; used?: number; size?: number }
  | {
      type: 'tool.start';
      toolCallId: string;
      toolName: string;
      args?: unknown;
      /** When the tool is a vault_sql call, the SQL is surfaced separately for the UI. */
      sql?: string;
      /** ACP tool kind when the agent supplied one (read/edit/delete/move/…​). */
      kind?: string;
      /** Lossless runner event envelope when the adapter exposes one. */
      rawJson?: string;
    }
  | {
      type: 'tool.result';
      toolCallId: string;
      toolName: string;
      ok: boolean;
      result?: unknown;
      /** Plain-text error message when `ok === false`. */
      errorText?: string;
      /**
       * Structured file diffs extracted from ACP tool content blocks
       * (`type: "diff"`), when the agent reported them.
       */
      diffs?: Array<{ path?: string; oldText?: string; newText?: string }>;
      /** Workspace files reported by ACP; the ledger stores path + hash refs. */
      locations?: Array<{ path: string; line?: number }>;
      /** Inline output without a workspace home; persisted to CAS by the host. */
      artifacts?: Array<{
        dataBase64: string;
        mime: string;
        filename?: string;
      }>;
      /** Lossless runner event envelope when the adapter exposes one. */
      rawJson?: string;
    }
  | {
      type: 'phase';
      phase: string;
      detail?: unknown;
      /** Normalized plan entries when `phase === 'plan'`. */
      plan?: Array<{ content: string; status?: string; priority?: string }>;
    }
  | {
      type: 'final';
      text: string;
      /** Runner-native completion reason, preserved verbatim. */
      stopReason?: string;
      /** Lossless runner completion envelope. */
      rawJson?: string;
    }
  | {
      type: 'error';
      message: string;
      /** Stable agent failure class used by breakers and turn-boundary failover. */
      failureClass?: AgentFailureClass;
      /** Runner-native completion reason, preserved verbatim. */
      stopReason?: string;
      /** Lossless runner completion envelope. */
      rawJson?: string;
    }
  | { type: 'aborted' }
  | {
      type: 'consent.required';
      consentKind: 'provider-egress';
      provider: RunnerKind;
      reason: 'direct' | 'ladder';
      message: string;
    }
  /**
   * A non-fatal, human-readable notice about the turn — surfaced in the
   * transcript and folded into the ledger as a notice step (issue #420).
   * A runner that can't consume an attachment kind (e.g. Codex silently drops
   * PDF `document` blocks) emits `code:'attachment_unsupported'` so the user
   * sees "this runner can't read PDF attachments" instead of nothing. Both
   * chat surfaces render it via the shared parser.
   */
  | { type: 'notice'; level: 'warn' | 'info'; code?: string; message: string }
  /**
   * Webhook secrets minted as a post-turn step (issue #141, Phase 3). When
   * a unified-chat turn authors an automation with a pending webhook
   * trigger, the gateway mints the route id + shared secret after the turn
   * settles (the agent can't generate crypto-random credentials) and
   * surfaces them here exactly once — the plaintext `secret` is never
   * persisted, so the renderer must capture it from this event. Adapters
   * that don't author code (data-only chat) never emit it.
   */
  | {
      type: 'webhooks';
      minted: Array<{
        automationId: string;
        ownerApp: string;
        webhookId: string;
        url: string;
        secret: string;
      }>;
    }
  /**
   * Per-turn token usage, emitted once when the runner reports the
   * turn's totals (codex `turn/completed`, Claude SDK `result`). The
   * chat route folds this into the turn's `kind='step'` run node so the
   * unified ledger has real token + cost accounting for chat turns.
   * Adapters that can't surface usage simply never emit it.
   */
  | {
      type: 'usage';
      model?: string;
      /** Confirmed live `thought_level`; requested-but-rejected values are omitted. */
      effort?: string;
      provider?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      /**
       * USD cost: agent/ACP-reported when present; otherwise filled at the SSE
       * seam from the catalog (issue #514). See `costSource`.
       */
      costUsd?: number;
      /** Where `costUsd` came from — agent report vs catalog estimate. */
      costSource?: 'agent' | 'estimated';
    };

export interface ConversationTurnInput {
  appId: string;
  /**
   * Optional draft-worktree session to use for this turn. Builder hosts use
   * this to isolate one-shot authoring work (such as an automation compile)
   * from the app's persistent interactive editing session.
   */
  draftSessionId?: string;
  /**
   * Absolute path to the app's data directory — `entry.path` as resolved by
   * `appDataDir(entry)`. For uploaded apps this is `<appsDir>/<id>`; for
   * path-registered apps it's the externally-supplied folder. `data.sqlite`
   * and the live schema live here. Adapters that spawn a subprocess agent
   * (codex / claude-code) MUST use this as the spawn cwd so the workspace
   * sandbox covers the file the agent reads/writes.
   */
  dataDir: string;
  /**
   * The chat session id — the `conversations` row id in the per-app runtime
   * SQLite the transcript persists to.
   */
  conversationId: string;
  /**
   * Absolute path to a runner-owned scratch session file (under the central
   * `conversationRunnerSessionDir`, named `<conversationId>.jsonl`). The runner is free to
   * use this for its own file-based session-resume mechanism, if it has one.
   * It is NOT the chat transcript — the transcript lives in the gateway DB.
   */
  sessionFile: string;
  message: string;
  /**
   * Which chat register the turn belongs to (issue #286 phase 2). `'ask'`
   * marks the user-facing app copilot ("operate/ask about my data") —
   * hosts may route vault-backed apps' ask turns onto the vault register
   * (vault_sql/vault_invoke with an app lens). Absent/`'build'` keeps the
   * builder-capable unified runner. Threaded from the `_turn` POST body.
   */
  register?: 'ask' | 'build';
  /**
   * Files attached to this turn's inbound message — already landed in the
   * per-app blob CAS; `path` is the absolute blob path (issue #190). The
   * route resolves these from the turn POST body's attachment refs; the
   * runner threads them into the adapter as multimodal content blocks.
   */
  attachments?: TurnAttachment[];
  /**
   * App-context prompt the app-engine builds (app name, description,
   * live schema). Adapters splice this into their own system-prompt flag.
   */
  extraSystemPrompt: string;
  /** Optional validated per-turn harness override (for automation manifests). */
  runnerKind?: RunnerKind;
  model?: string;
  /** Optional category-keyed ACP pins (`model`, `thought_level`, future categories). */
  configPins?: Readonly<Record<string, string>>;
  /**
   * Providers explicitly approved by the owner for this request. A client
   * accumulates consents across a conversation and re-sends the whole set, so
   * a second cross-provider switch does not silently revoke the first. A bare
   * string stays wire-valid and means a one-element set.
   */
  providerConsent?: RunnerKind | readonly RunnerKind[];
  /** Explicitly owner-selected extra workspace roots for this conversation. */
  additionalDirectories?: string[];
  /** Host-resolved Centraid workspace root selected for this conversation. */
  workspaceDirectory?: string;
  /** Durable selector value that produced `workspaceDirectory`. */
  workspaceKind?: ConversationWorkspaceKind;
  thinking?: string;
  /**
   * ACP permission-request policy for this turn. Interactive automation
   * conversations set `deny`: an enrolled automation may use only the tools
   * and vault grants the host already exposed, and can never widen that set
   * through an agent-rendered permission prompt.
   */
  permissionPolicy?: 'auto-allow' | 'deny';
  abortSignal: AbortSignal;
  /**
   * Idempotency key supplied by the harness — same turn re-tried with the
   * same key should not be re-driven if the adapter supports it. Plumbed
   * through but not load-bearing (the route's `abortSignal` plus the
   * per-window queue is the primary correctness guarantee).
   */
  idempotencyKey?: string;
  /**
   * The runner's previous resume handle, read from the `conversations` row
   * by the route. The adapter resumes only when `prevAdapterKind` matches
   * the kind it's about to use — a mid-session runner switch starts fresh.
   */
  prevAdapterSessionId?: string;
  /** Durable binding row that supplied `prevAdapterSessionId`. */
  prevBindingId?: string;
  /**
   * Provider that owns the conversation's currently active binding. This is
   * deliberately separate from `prevAdapterKind`: a requested provider may
   * have an older warm binding even though another provider is active.
   * Provider-egress consent is based on this active-provider axis.
   */
  activeAdapterKind?: string;
  prevAdapterKind?: string;
  /** Cumulative counters stored with the prior ACP session id. */
  prevAdapterUsageSnapshot?: AdapterUsageSnapshot;
  /** Bounded canonical-ledger context available if this turn starts fresh. */
  hydrationContext?: {
    prompt: string;
    includedTurns: number;
    omittedTurns: number;
    /** Estimated prompt tokens injected solely to restore ledger context. */
    estimatedTokens: number;
  };
  /** Historical files re-attached only if the target advertises their block type. */
  hydrationAttachments?: import('./turn.js').TurnAttachment[];
  /** Full-ledger recovery plan used only if this runner's own resume handle expired. */
  recoveryHydrationContext?: {
    prompt: string;
    includedTurns: number;
    omittedTurns: number;
    /** Estimated prompt tokens injected solely to restore ledger context. */
    estimatedTokens: number;
  };
  /** Full-ledger counterpart to `hydrationAttachments`. */
  recoveryHydrationAttachments?: import('./turn.js').TurnAttachment[];
  /**
   * Per-rung resume + hydration planner, injected by the turn driver (which
   * owns the conversation store). The failover ladder can land on a provider
   * other than the one the route targeted, and every rung has its OWN binding
   * and its OWN hydration watermark. Resolving the plan once against the
   * primary target and reusing it down the ladder loses the whole
   * conversation: a fallback rung would start with no resume handle AND no
   * hydration.
   *
   * Absent on hosts with no conversation store (automation dispatch paths) —
   * the spine then falls back to the precomputed `prevAdapter*` /
   * `hydration*` fields above, which is exactly the pre-existing behavior.
   */
  resumeForKind?: (kind: RunnerKind) => TurnResumePlan | undefined;
  onEvent: (event: TurnStreamEvent) => void;
}

/** One runner kind's resume handle plus the hydration it would need. */
export interface TurnResumePlan {
  /** That runner's own resumable opaque session id, when it has a binding. */
  sessionId?: string;
  /** Durable binding row that supplied `sessionId`. */
  bindingId?: string;
  /** Cumulative counters stored with `sessionId`. */
  usageSnapshot?: AdapterUsageSnapshot;
  /** Ledger delta past THIS binding's watermark (the full ledger when cold). */
  hydrationContext?: ConversationTurnInput['hydrationContext'];
  hydrationAttachments?: import('./turn.js').TurnAttachment[];
  /** Full-ledger plan used only if `sessionId` turns out to be expired. */
  recoveryHydrationContext?: ConversationTurnInput['recoveryHydrationContext'];
  recoveryHydrationAttachments?: import('./turn.js').TurnAttachment[];
}

export interface ConversationTurnResult {
  /**
   * Resumable session id assigned by the adapter (codex thread id,
   * claude-code session id). Omitted by adapters whose resume happens via
   * the on-disk `sessionFile` instead. The route handler persists this to
   * the session's `conversations` row so the next turn can resume.
   */
  adapterSessionId?: string;
  /** Adapter kind that wrote `adapterSessionId`. */
  adapterKind?: string;
  /** Cumulative counters to persist with the resume handle. */
  adapterUsageSnapshot?: AdapterUsageSnapshot;
  /** True when a fresh runner/session consumed canonical ledger hydration. */
  hydrated?: boolean;
  /**
   * Which hydration the adapter actually consumed. `'recovery'` means the
   * resume handle we supplied was rejected and the adapter self-healed onto a
   * fresh session — the signal the driver uses to retire the dead binding.
   */
  hydrationKind?: 'handoff' | 'recovery';
  /**
   * Estimated tokens of the hydration prompt actually consumed. Present only
   * when `hydrated` is true; persisted separately from ordinary ACP usage.
   */
  hydrationTokens?: number;
}

export interface ConversationRunner {
  /** Resolve this surface's currently selected runner before hydration lookup. */
  resolveRunnerKind?: () => Promise<RunnerKind | undefined>;
  /**
   * The ledger `RunKind` a turn through this runner persists as — a property
   * of the *surface*, not the individual turn. The builder-capable unified
   * runner (draft worktree + file-edit tools + authoring prompt) reports
   * `'build'`; the data-only runner leaves it unset (the route defaults to
   * `'chat'`). Read statically by the route, so the kind is recorded even
   * when a turn errors and returns no `ConversationTurnResult` (issue #181).
   */
  readonly runKind?: RunKind;
  /** Drive one turn. Resolves when the model has emitted its final reply
   *  or the run aborted/errored. Errors are reported via `onEvent`
   *  (type: 'error') AND by rejecting the returned promise — the route
   *  handler relies on the rejection to release the per-session lock. */
  run: (input: ConversationTurnInput) => Promise<ConversationTurnResult | void>;
}
