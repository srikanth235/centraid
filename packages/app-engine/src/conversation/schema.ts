/*
 * Conversation / turn / item row types (issue #90, reshaped by #190).
 *
 * Pure types — the table DDL lives in `gateway-db.ts` (RUNTIME_MIGRATIONS:
 * `conversations`, `turns`, `items`, `attachments`, `automation_state`).
 * These shapes are exported separately so callers (the SQLite-backed
 * `ConversationStore` in `store.ts` and the desktop UI) can
 * import the row types without pulling in the store implementation.
 *
 * "Everything is chat" (issue #190): the **conversation** is the first-class
 * spine. A chat window, an automation, and a builder session are each a
 * single-kind conversation; `RunKind` discriminates and lives on the
 * conversation, not re-stamped per turn. A **turn** is one execution under
 * it — a chat turn, an automation fire, a builder iteration. **Items** are
 * the ordered trace, now including the inbound message (`kind='message_in'`,
 * ordinal 0): the user/trigger input is a first-class message, same shape as
 * the response. **Attachments** ride that inbound message.
 */

/** What kind of thread this conversation is. Insights groups `automation` by automation. */
export type RunKind = 'automation' | 'chat' | 'build';

/**
 * Why a turn fired. `interactive` is a chat turn; the rest are automation
 * fires.
 */
export type AutomationTriggerKind =
  | 'scheduled'
  | 'manual'
  | 'replay'
  | 'on_failure'
  | 'interactive';

/**
 * What *source* fired a turn (issue #96). `cron` is a scheduler fire,
 * `webhook` an inbound HTTP POST, `manual` an explicit "Run now". Distinct
 * from `AutomationTriggerKind`, which records intent rather than transport.
 */
export type AutomationTriggerOrigin = 'cron' | 'webhook' | 'manual';

/**
 * Item discriminator. `message_in` is the inbound message — a person typing,
 * a webhook firing, a cron tick — recorded as ordinal 0 of the turn
 * (issue #190). `step` is one primary model-inference call — per-call token +
 * cost accounting lives at this grain. `tool` / `agent` are per-call audit
 * rows.
 */
export type ItemKind = 'message_in' | 'step' | 'tool' | 'agent';

/**
 * The durable record holding the turns of one execution. Was `chat_sessions`,
 * generalized: `kind` / `app_id` / `automation_id` moved UP here off the
 * per-turn row. For `kind='automation'` each fire is its OWN conversation
 * (fresh id) tagged with the automation ref in `automation_id`, so an
 * automation's run history is the conversations sharing that ref.
 */
export interface Conversation {
  readonly id: string;
  readonly kind: RunKind;
  /** Owner — the gateway-side user UUID from `UserStore` (empty for automations). */
  readonly userId: string;
  /** Owning app — set for automation and build conversations. */
  readonly appId?: string;
  /** The automation ref (`<appId>/<id>`) this fire ran — set for `kind: 'automation'`. */
  readonly automationId?: string;
  readonly title: string;
  /** Runner kind that owns `adapterSessionId` (codex | claude-code | openclaw). */
  readonly adapterKind?: string;
  /** Opaque per-runner resume handle; absent until the first turn lands. */
  readonly adapterSessionId?: string;
  /** Number of completed turns on this conversation. */
  readonly turnCount: number;
  /**
   * When true the conversation is kept: retention pruning skips its turns
   * and a `replay` fire can serve its recorded items (issue #80 follow-up).
   */
  readonly pinned: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Turn {
  readonly turnId: string;
  /**
   * The conversation this turn belongs to — NOT NULL, FK-backed, CASCADE
   * (issue #190). For an automation, this equals the automation id.
   */
  readonly conversationId: string;
  /** Ordinal within the thread (0-based). */
  readonly seq: number;
  readonly parentTurnId?: string;
  readonly triggerKind: AutomationTriggerKind;
  /** Source that fired the turn (`cron` / `webhook` / `manual`). */
  readonly triggerOrigin?: AutomationTriggerOrigin;
  /** One-line human-readable label for the activity feed. */
  readonly note?: string;
  /** When this turn is a retry, the turn id it re-runs. */
  readonly retryOf?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly ok: boolean;
  readonly error?: string;
  readonly summary?: string;
  /**
   * The turn's structured result. For an automation it is the handler's
   * validated `output` envelope, read back by `ctx.runs.last().output` and
   * fed to an `onFailure` cascade. (The inbound message moved to a
   * `message_in` item; this terminal output stays on the turn since there is
   * no `message_out` item kind — issue #190.)
   */
  readonly outputJson?: string;
  /**
   * When true the turn is a kept fixture: its recorded `items` can be replayed
   * by a `triggerKind: 'replay'` fire, and retention pruning skips it.
   */
  readonly pinned: boolean;
  /**
   * Denormalized rollup, written at finish. Token sums + cost are Σ over this
   * turn's own `kind IN ('step','agent')` items. Null on an in-flight or
   * crashed turn.
   */
  readonly totalInputTokens?: number;
  readonly totalOutputTokens?: number;
  readonly totalCacheReadTokens?: number;
  readonly totalCacheWriteTokens?: number;
  readonly totalCostUsd?: number;
  readonly stepCount?: number;
  readonly toolCount?: number;
}

export interface Item {
  readonly itemId: string;
  readonly turnId: string;
  readonly ordinal: number;
  readonly batchId?: number;
  readonly kind: ItemKind;
  /** `message_in` messages: 'user' (incl. a webhook/cron trigger) | 'assistant'. */
  readonly role?: 'user' | 'assistant';
  /** `message_in` payload text. (Assistant step text stays in `outputJson`.) */
  readonly text?: string;
  /** The tool name or `'agent'`. Absent for `kind: 'step'` / `'message_in'`. */
  readonly name?: string;
  readonly argsJson?: string;
  readonly outputJson?: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  /** `step` / `agent` — per-call token usage. */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** `step` / `agent` — the model + provider that served the call. */
  readonly model?: string;
  readonly provider?: string;
  /** Frozen at write time from the per-model price table; absent = no price known. */
  readonly costUsd?: number;
  /** `tool` / `agent` — the app whose data the call touched. */
  readonly appId?: string;
  /** `agent` — the turn id of a child turn this item spawned (sub-agent). */
  readonly childTurnId?: string;
}

/**
 * A file that arrived on an inbound message — a chat upload OR a webhook /
 * email / folder-watch file (issue #190). Universal across all kinds. FK'd
 * to the `message_in` item it rode in on (CASCADE). The bytes live
 * content-addressed on disk at `<appsDir>/<appId>/blobs/<hash>`, never in
 * sqlite — `hash` is the CAS key.
 */
export interface Attachment {
  readonly id: string;
  readonly itemId: string;
  readonly hash: string;
  readonly mime: string;
  readonly sizeBytes: number;
  /** `'upload'` | `'webhook'` | `'email'` | … */
  readonly source?: string;
  readonly filename?: string;
  readonly createdAt: number;
}

export interface AutomationStateEntry {
  readonly automationId: string;
  readonly key: string;
  readonly valueJson: string;
  readonly updatedAt: number;
}
