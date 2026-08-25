// governance: allow-repo-hygiene file-size-limit #190 — one ConversationStore class; its SQL and row mappers already live in store-sql.ts and schema.ts
/*
 * The per-vault conversation ledger + automation KV, in the vault's
 * `journal.db`. A conversation binds to its vault at creation, and app scoping
 * is the `app_id` COLUMN, not a file (#280). The `DatabaseProvider` may resolve
 * "the ACTIVE vault", so the store re-prepares when the handle changes.
 * Runtime-owned: never reachable from the handler `db` proxy or `vault_sql`.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { DatabaseProvider } from "../stores/gateway-db.js";
import type { ArchiveSegmentRef } from "./rehydrate.js";
import type {
  Conversation,
  Turn,
  Item,
  Attachment,
  AutomationStateEntry,
  AutomationTriggerKind,
  AutomationTriggerOrigin,
  ConversationHarnessSession,
  ConversationWorkspaceKind,
  ConversationWorkspaceSelection,
  ItemKind,
  RunKind,
} from "./schema.js";
import {
  prepare,
  conversationFromRaw,
  turnFromRaw,
  itemFromRaw,
  attachmentFromRaw,
  stateFromRaw,
} from "./store-sql.js";
import type {
  PreparedStatements,
  RawConversation,
  RawTurn,
  RawItem,
  RawAttachment,
  RawState,
} from "./store-sql.js";
import type { HarnessUsageSnapshot } from "./turn.js";

export interface CreateConversationInput {
  readonly id?: string;
  readonly kind: RunKind;
  readonly userId: string;
  readonly appId?: string;
  readonly automationId?: string;
  readonly title?: string;
  readonly harnessKind?: string;
}

export interface InsertTurnInput {
  readonly turnId: string;
  readonly conversationId: string;
  readonly triggerKind: AutomationTriggerKind;
  readonly triggerOrigin?: AutomationTriggerOrigin;
  readonly parentTurnId?: string;
  readonly retryOf?: string;
  readonly idempotencyKey?: string;
  readonly note?: string;
  /** Estimated handoff prompt tokens, never ACP usage. */
  readonly hydrationTokens?: number;
  readonly startedAt: number;
}

export interface FinishTurnInput {
  readonly turnId: string;
  readonly endedAt: number;
  readonly ok: boolean;
  readonly error?: string;
  readonly summary?: string;
  readonly outputJson?: string;
}

export interface InsertMessageInInput {
  readonly turnId: string;
  readonly itemId?: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly startedAt: number;
}

export interface InsertItemInput {
  readonly itemId: string;
  readonly turnId: string;
  readonly ordinal: number;
  readonly callId?: string;
  readonly batchId?: number;
  readonly kind: ItemKind;
  readonly role?: "user" | "assistant";
  readonly text?: string;
  readonly name?: string;
  readonly argsJson?: string;
  readonly outputJson?: string;
  readonly rawJson?: string;
  readonly childTurnId?: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly model?: string;
  readonly harness?: string;
  readonly effort?: string;
  readonly costUsd?: number;
  /** Issue #514 — `harness` (ACP) or `estimated` (catalog). */
  readonly costSource?: "harness" | "estimated";
  readonly appId?: string;
}

export interface OpenItemInput {
  readonly itemId: string;
  readonly turnId: string;
  readonly ordinal: number;
  readonly callId?: string;
  readonly batchId?: number;
  readonly kind: ItemKind;
  readonly name?: string;
  readonly argsJson?: string;
  readonly rawJson?: string;
  readonly appId?: string;
  readonly startedAt: number;
}

export interface CloseItemInput {
  readonly itemId: string;
  readonly ok: boolean;
  readonly outputJson?: string;
  readonly rawJson?: string;
  readonly error?: string;
  readonly childTurnId?: string;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly model?: string;
  readonly harness?: string;
  readonly effort?: string;
  readonly costUsd?: number;
  /** Issue #514 — `harness` (ACP) or `estimated` (catalog). */
  readonly costSource?: "harness" | "estimated";
}

export interface InsertAttachmentInput {
  readonly id?: string;
  readonly itemId: string;
  readonly hash: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly source?: string;
  readonly filename?: string;
  readonly workspacePath?: string;
}

export interface ListTurnsOptions {
  readonly status?: "ok" | "error";
  readonly since?: number;
  readonly limit?: number;
}

export type ConversationMeta = Conversation & { readonly messageCount: number };

export type ConversationSearchHit = ConversationMeta & {
  readonly snippet: string;
};

/** QUOTING neutralizes FTS operators so they match as literals; a word with no
 *  letter or digit is dropped (an empty phrase is a syntax error). */
export function conversationMatchExpression(query: string): string | null {
  const tokens = query
    .split(/\s+/u)
    .map((t) => t.replaceAll('"', ""))
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .slice(0, 16);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(" ");
}

/** Not page sizes (#659): the point past which a response stops being
 *  renderable at all, so raising one is a product decision. */
export const MAX_TRANSCRIPT_TURNS = 2000;

export interface TurnWindow {
  turns: Turn[];
  hasMore: boolean;
  oldestSeq?: number;
}

export interface TurnSeqRange {
  fromSeq?: number;
  toSeq?: number;
}
export const MAX_LISTED_CONVERSATIONS = 500;

/** `raw_json` repeats the whole payload and is written TWICE per tool call.
 *  Enforced at the WRITE boundary so no producer can forget. */
const RAW_JSON_MAX_BYTES = 64 * 1024;

const RAW_JSON_KEPT_FIELD_MAX_CHARS = 256;

/** Keeps top-level scalars short enough to be identifiers, drops the nested
 *  content that blew the cap, and returns `{}` for a non-JSON envelope. */
function rawJsonForensics(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return {};
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      if (value.length <= RAW_JSON_KEPT_FIELD_MAX_CHARS) kept[key] = value;
    } else if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      kept[key] = value;
    }
  }
  return kept;
}

/** Verbatim under the cap, else forensics plus a truncation marker. */
function cappedRawJson(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const originalBytes = Buffer.byteLength(raw, "utf8");
  if (originalBytes <= RAW_JSON_MAX_BYTES) return raw;
  const marker = { rawTruncated: true, rawOriginalBytes: originalBytes };
  const kept = JSON.stringify({ ...rawJsonForensics(raw), ...marker });
  // A pathological envelope can still exceed the cap; the marker always fits.
  return Buffer.byteLength(kept, "utf8") <= RAW_JSON_MAX_BYTES
    ? kept
    : JSON.stringify(marker);
}

export class ConversationStore {
  private readonly provider: DatabaseProvider;
  private db: DatabaseSync | undefined;
  private stmts: PreparedStatements | undefined;

  constructor(provider: DatabaseProvider) {
    this.provider = provider;
  }

  private ensureReady(): { db: DatabaseSync; stmts: PreparedStatements } {
    // The provider may resolve a DIFFERENT handle across calls, so re-prepare
    // on change and a vault switch needs no reconstruction.
    const db = this.provider();
    if (this.db === db && this.stmts) return { db, stmts: this.stmts };
    const stmts = prepare(db);
    this.db = db;
    this.stmts = stmts;
    return { db, stmts };
  }

  runInTransaction<T>(fn: () => T): T {
    const { db } = this.ensureReady();
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw error;
    }
  }

  // ─── conversations ──────────────────────────────────────────────────

  createConversation(input: CreateConversationInput): Conversation {
    const { stmts } = this.ensureReady();
    const now = Date.now();
    const id = input.id ?? randomUUID();
    stmts.insertConversation.run(
      id,
      input.kind,
      input.userId,
      input.appId ?? null,
      input.automationId ?? null,
      input.title ?? "",
      input.harnessKind ?? null,
      now,
      now
    );
    return {
      id,
      kind: input.kind,
      userId: input.userId,
      ...(input.appId === undefined ? {} : { appId: input.appId }),
      ...(input.automationId === undefined
        ? {}
        : { automationId: input.automationId }),
      title: input.title ?? "",
      ...(input.harnessKind === undefined
        ? {}
        : { harnessKind: input.harnessKind }),
      hydrationCount: 0,
      turnCount: 0,
      pinned: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Harness ownership is a MUTABLE binding, never conversation identity, so a
   *  switch keeps one contiguous history. */
  ensureAutomationConversation(
    automationRef: string,
    appId?: string,
    name?: string,
    harnessKind?: string
  ): string {
    const conversationId = automationRef;
    const existing = this.getConversation(conversationId);
    if (!existing) {
      this.createConversation({
        id: conversationId,
        kind: "automation",
        userId: "",
        automationId: automationRef,
        ...(appId === undefined ? {} : { appId }),
        ...(name === undefined ? {} : { title: name }),
        ...(harnessKind === undefined ? {} : { harnessKind }),
      });
      return conversationId;
    }
    if (
      existing.kind !== "automation" ||
      existing.automationId !== automationRef
    ) {
      throw new Error(
        `conversation id collision for automation "${conversationId}"`
      );
    }
    const { stmts } = this.ensureReady();
    stmts.updateAutomationConversation.run(
      appId ?? null,
      name ?? null,
      Date.now(),
      conversationId,
      automationRef
    );
    return conversationId;
  }

  getConversation(id: string): Conversation | undefined {
    const { stmts } = this.ensureReady();
    const raw = stmts.getConversation.get(id) as RawConversation | undefined;
    return raw ? conversationFromRaw(raw) : undefined;
  }

  getConversationMeta(
    id: string,
    userId: string
  ): ConversationMeta | undefined {
    const { stmts } = this.ensureReady();
    const raw = stmts.getConversationWithCount.get(id, userId) as
      | (RawConversation & { msg_count: number })
      | undefined;
    if (!raw) return undefined;
    return { ...conversationFromRaw(raw), messageCount: Number(raw.msg_count) };
  }

  /** The ledger file is per VAULT, so `appId` scoping is a COLUMN filter,
   *  never a file boundary (#280). */
  listConversationsMeta(userId: string, appId?: string): ConversationMeta[] {
    const { stmts } = this.ensureReady();
    const rows = stmts.listConversations.all(
      userId,
      appId ?? null,
      appId ?? null,
      MAX_LISTED_CONVERSATIONS
    ) as unknown as (RawConversation & {
      msg_count: number;
    })[];
    return rows.map((r) => ({
      ...conversationFromRaw(r),
      messageCount: Number(r.msg_count),
    }));
  }

  /** Archived threads are excluded. */
  searchConversations(
    userId: string,
    query: string,
    appId?: string,
    limit = 20
  ): ConversationSearchHit[] {
    const match = conversationMatchExpression(query);
    if (!match) return [];
    const { stmts } = this.ensureReady();
    const rows = stmts.searchConversations.all(
      match,
      userId,
      appId ?? null,
      appId ?? null,
      Math.min(Math.max(limit, 1), 100)
    ) as unknown as (RawConversation & {
      msg_count: number;
      snippet: string;
    })[];
    return rows.map((r) => ({
      ...conversationFromRaw(r),
      messageCount: Number(r.msg_count),
      snippet: r.snippet ?? "",
    }));
  }

  renameConversation(id: string, userId: string, title: string): boolean {
    const { stmts } = this.ensureReady();
    return (
      Number(
        stmts.renameConversation.run(title, Date.now(), id, userId).changes
      ) > 0
    );
  }

  setConversationPinned(id: string, userId: string, pinned: boolean): boolean {
    const { stmts } = this.ensureReady();
    return (
      Number(
        stmts.setConversationPinned.run(pinned ? 1 : 0, Date.now(), id, userId)
          .changes
      ) > 0
    );
  }

  setConversationArchived(
    id: string,
    userId: string,
    archived: boolean
  ): boolean {
    const { stmts } = this.ensureReady();
    return (
      Number(
        stmts.setConversationArchived.run(
          archived ? 1 : 0,
          Date.now(),
          id,
          userId
        ).changes
      ) > 0
    );
  }

  deleteConversation(id: string, userId: string): boolean {
    const { stmts } = this.ensureReady();
    return Number(stmts.deleteConversationForUser.run(id, userId).changes) > 0;
  }

  deleteAutomationData(automationRef: string): void {
    const { stmts } = this.ensureReady();
    stmts.deleteConversationByAutomation.run(automationRef);
    stmts.deleteStateByAutomation.run(automationRef);
  }

  titleOf(id: string, userId: string): string | undefined {
    const { stmts } = this.ensureReady();
    const row = stmts.titleOf.get(id, userId) as { title: string } | undefined;
    return row?.title;
  }

  setTitle(id: string, userId: string, title: string, now: number): void {
    const { stmts } = this.ensureReady();
    stmts.setTitle.run(title, now, id, userId);
  }

  setKind(id: string, userId: string, kind: RunKind): void {
    const { stmts } = this.ensureReady();
    stmts.setKind.run(kind, id, userId);
  }

  touchConversation(id: string, userId: string, now: number): void {
    const { stmts } = this.ensureReady();
    stmts.touchConversation.run(now, id, userId);
  }

  noteTurn(
    id: string,
    userId: string,
    observation?: {
      kind: string;
      sessionId?: string;
      usageSnapshot?: HarnessUsageSnapshot;
      hydrated?: boolean;
    }
  ): boolean {
    const { db, stmts } = this.ensureReady();
    const now = Date.now();
    const hydrated = observation?.hydrated === true ? 1 : 0;
    let res;
    if (observation && observation.sessionId !== undefined) {
      // `turns.seq` starts at 0, so the "nothing hydrated yet" sentinel is -1:
      // a 0 would silently exclude the first turn from every later delta.
      const maxSeq = Number(
        (
          db
            .prepare(
              `SELECT COALESCE(MAX(seq), -1) AS seq FROM turns WHERE conversation_id = ?`
            )
            .get(id) as { seq: number }
        ).seq
      );
      // One active plus at most one warm candidate, without discarding older
      // valid handles: a displaced warm binding goes COLD, and `stale` is
      // reserved for handles that must never be resumed again.
      const active = db
        .prepare(
          `SELECT harness_kind, acp_session_id
             FROM conversation_harness_sessions
            WHERE conversation_id = ? AND status = 'active'
            LIMIT 1`
        )
        .get(id) as
        | { harness_kind: string; acp_session_id: string }
        | undefined;
      const activeChanges =
        active !== undefined &&
        (active.harness_kind !== observation.kind ||
          active.acp_session_id !== observation.sessionId);
      if (activeChanges) {
        db.prepare(
          `UPDATE conversation_harness_sessions
              SET status = 'cold'
            WHERE conversation_id = ? AND status = 'warm'
              AND NOT (harness_kind = ? AND acp_session_id = ?)`
        ).run(id, observation.kind, observation.sessionId);
        db.prepare(
          `UPDATE conversation_harness_sessions
              SET status = 'warm'
            WHERE conversation_id = ? AND status = 'active'
              AND NOT (harness_kind = ? AND acp_session_id = ?)`
        ).run(id, observation.kind, observation.sessionId);
      }
      db.prepare(
        `INSERT INTO conversation_harness_sessions (
           id, conversation_id, harness_kind, acp_session_id, usage_snapshot_json,
           hydrated_through_seq, status, last_used_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(conversation_id, harness_kind, acp_session_id) DO UPDATE SET
           usage_snapshot_json = excluded.usage_snapshot_json,
           hydrated_through_seq = MAX(
             conversation_harness_sessions.hydrated_through_seq,
             excluded.hydrated_through_seq
           ),
           status = 'active',
           last_used_at = excluded.last_used_at`
      ).run(
        randomUUID(),
        id,
        observation.kind,
        observation.sessionId,
        observation.usageSnapshot
          ? JSON.stringify(observation.usageSnapshot)
          : null,
        maxSeq,
        now,
        now
      );
      // One resumable binding per harness; superseded ids stay as `stale`
      // audit rows rather than silently disappearing.
      db.prepare(
        `UPDATE conversation_harness_sessions
            SET status = 'stale'
          WHERE conversation_id = ?
            AND harness_kind = ?
            AND acp_session_id <> ?
            AND status <> 'stale'`
      ).run(id, observation.kind, observation.sessionId);
      res = stmts.noteTurnWithHarness.run(
        now,
        observation.kind,
        observation.sessionId,
        observation.usageSnapshot
          ? JSON.stringify(observation.usageSnapshot)
          : null,
        hydrated,
        hydrated,
        now,
        id,
        userId
      );
      // Set AFTER the conversation update, so the watermark always observes
      // the inserting transaction's final seq.
      db.prepare(
        `UPDATE conversation_harness_sessions
            SET hydrated_through_seq = MAX(
              hydrated_through_seq,
              (SELECT COALESCE(MAX(seq), -1) FROM turns WHERE conversation_id = ?)
            )
          WHERE conversation_id = ? AND harness_kind = ? AND acp_session_id = ?`
      ).run(id, id, observation.kind, observation.sessionId);
    } else if (observation) {
      res = stmts.noteTurnKindOnly.run(
        now,
        observation.kind,
        hydrated,
        hydrated,
        now,
        id,
        userId
      );
    } else {
      res = stmts.noteTurnNoHarness.run(now, id, userId);
    }
    return Number(res.changes) > 0;
  }

  /** Settles a SECOND harness touched in one turn, without bumping the turn
   *  counter or replacing the active harness. */
  settleAdditionalHarness(
    id: string,
    observation: {
      kind: string;
      sessionId?: string;
      usageSnapshot?: HarnessUsageSnapshot;
      hydrated?: boolean;
    }
  ): boolean {
    const { db } = this.ensureReady();
    if (!observation.sessionId) return false;
    const exists = db
      .prepare(`SELECT 1 AS found FROM conversations WHERE id = ?`)
      .get(id) as { found: number } | undefined;
    if (!exists) return false;
    const now = Date.now();
    const maxSeq = Number(
      (
        db
          .prepare(
            `SELECT COALESCE(MAX(seq), -1) AS seq FROM turns WHERE conversation_id = ?`
          )
          .get(id) as { seq: number }
      ).seq
    );
    db.prepare(
      `INSERT INTO conversation_harness_sessions (
         id, conversation_id, harness_kind, acp_session_id, usage_snapshot_json,
         hydrated_through_seq, status, last_used_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'cold', ?, ?)
       ON CONFLICT(conversation_id, harness_kind, acp_session_id) DO UPDATE SET
         usage_snapshot_json = excluded.usage_snapshot_json,
         hydrated_through_seq = MAX(
           conversation_harness_sessions.hydrated_through_seq,
           excluded.hydrated_through_seq
         ),
         last_used_at = excluded.last_used_at
       WHERE conversation_harness_sessions.status <> 'stale'`
    ).run(
      randomUUID(),
      id,
      observation.kind,
      observation.sessionId,
      observation.usageSnapshot
        ? JSON.stringify(observation.usageSnapshot)
        : null,
      maxSeq,
      now,
      now
    );
    db.prepare(
      `UPDATE conversation_harness_sessions
          SET status = 'stale'
        WHERE conversation_id = ? AND harness_kind = ? AND acp_session_id <> ?
          AND status <> 'stale'`
    ).run(id, observation.kind, observation.sessionId);
    if (observation.hydrated) {
      db.prepare(
        `UPDATE conversations
            SET hydration_count = hydration_count + 1,
                last_hydrated_at = ?
          WHERE id = ?`
      ).run(now, id);
    }
    return true;
  }

  settleAdditionalFailedHarness(
    id: string,
    observation: {
      kind: string;
      sessionId?: string;
      usageSnapshot?: HarnessUsageSnapshot;
    }
  ): void {
    if (!observation.sessionId) return;
    const { db } = this.ensureReady();
    db.prepare(
      `UPDATE conversation_harness_sessions
          SET usage_snapshot_json = COALESCE(?, usage_snapshot_json),
              last_used_at = ?
        WHERE conversation_id = ? AND harness_kind = ? AND acp_session_id = ?
          AND status <> 'stale'`
    ).run(
      observation.usageSnapshot
        ? JSON.stringify(observation.usageSnapshot)
        : null,
      Date.now(),
      id,
      observation.kind,
      observation.sessionId
    );
  }

  /** A new target session is deliberately NOT inserted: failure must never
   *  replace the prior active binding. The hydration watermark is likewise NOT
   *  advanced — the failed message never reached the model. */
  noteFailedTurn(
    id: string,
    userId: string,
    observation?: {
      kind: string;
      sessionId?: string;
      usageSnapshot?: HarnessUsageSnapshot;
      hydrated?: boolean;
    }
  ): boolean {
    const { db, stmts } = this.ensureReady();
    const now = Date.now();
    const res = stmts.noteTurnNoHarness.run(now, id, userId);
    if (Number(res.changes) === 0) return false;
    if (observation?.sessionId) {
      db.prepare(
        `UPDATE conversation_harness_sessions
            SET usage_snapshot_json = COALESCE(?, usage_snapshot_json),
                last_used_at = ?
          WHERE conversation_id = ? AND harness_kind = ? AND acp_session_id = ?
            AND status <> 'stale'`
      ).run(
        observation.usageSnapshot
          ? JSON.stringify(observation.usageSnapshot)
          : null,
        now,
        id,
        observation.kind,
        observation.sessionId
      );
    }
    if (observation?.hydrated) {
      db.prepare(
        `UPDATE conversations
            SET hydration_count = hydration_count + 1,
                last_hydrated_at = ?
          WHERE id = ? AND user_id = ?`
      ).run(now, id, userId);
    }
    return true;
  }

  getHarnessBinding(
    conversationId: string,
    harnessKind: string
  ): ConversationHarnessSession | undefined {
    const { db } = this.ensureReady();
    const raw = db
      .prepare(
        `SELECT id, conversation_id, harness_kind, acp_session_id,
                usage_snapshot_json, hydrated_through_seq, status,
                last_used_at, created_at
           FROM conversation_harness_sessions
          WHERE conversation_id = ? AND harness_kind = ? AND status <> 'stale'
          ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, last_used_at DESC
          LIMIT 1`
      )
      .get(conversationId, harnessKind) as
      | {
          id: string;
          conversation_id: string;
          harness_kind: string;
          acp_session_id: string;
          usage_snapshot_json: string | null;
          hydrated_through_seq: number;
          status: "active" | "warm" | "cold";
          last_used_at: number;
          created_at: number;
        }
      | undefined;
    if (!raw) return undefined;
    let usageSnapshot: HarnessUsageSnapshot | undefined;
    if (raw.usage_snapshot_json) {
      try {
        usageSnapshot = JSON.parse(
          raw.usage_snapshot_json
        ) as HarnessUsageSnapshot;
      } catch {
        // A corrupt accounting snapshot must not hide the resume handle.
      }
    }
    return {
      id: raw.id,
      conversationId: raw.conversation_id,
      kind: raw.harness_kind,
      acpSessionId: raw.acp_session_id,
      ...(usageSnapshot ? { usageSnapshot } : {}),
      hydratedThroughSeq: Number(raw.hydrated_through_seq),
      status: raw.status,
      lastUsedAt: raw.last_used_at,
      createdAt: raw.created_at,
    };
  }

  markHarnessBindingStale(id: string): void {
    this.ensureReady()
      .db.prepare(
        `UPDATE conversation_harness_sessions
            SET status = 'stale'
          WHERE id = ?`
      )
      .run(id);
  }

  acquireTurnLock(
    conversationId: string,
    token: string,
    now = Date.now()
  ): boolean {
    const { db } = this.ensureReady();
    const staleBefore = now - 30 * 60_000;
    const result = db
      .prepare(
        `INSERT INTO conversation_turn_locks (conversation_id, lock_token, acquired_at)
         VALUES (?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           lock_token = excluded.lock_token,
           acquired_at = excluded.acquired_at
         WHERE conversation_turn_locks.acquired_at < ?`
      )
      .run(conversationId, token, now, staleBefore);
    return Number(result.changes) > 0;
  }

  /** A stale owner must not revive a lock another process has taken over. */
  refreshTurnLock(
    conversationId: string,
    token: string,
    now = Date.now()
  ): boolean {
    const result = this.ensureReady()
      .db.prepare(
        `UPDATE conversation_turn_locks
            SET acquired_at = ?
          WHERE conversation_id = ? AND lock_token = ?`
      )
      .run(now, conversationId, token);
    return Number(result.changes) > 0;
  }

  releaseTurnLock(conversationId: string, token: string): void {
    this.ensureReady()
      .db.prepare(
        `DELETE FROM conversation_turn_locks
          WHERE conversation_id = ? AND lock_token = ?`
      )
      .run(conversationId, token);
  }

  getWorkspaceSelection(
    conversationId: string
  ): ConversationWorkspaceSelection | undefined {
    const raw = this.ensureReady()
      .db.prepare(
        `SELECT conversation_id, primary_kind, additional_directories_json, updated_at
           FROM conversation_workspace_selection
          WHERE conversation_id = ?`
      )
      .get(conversationId) as
      | {
          conversation_id: string;
          primary_kind: ConversationWorkspaceKind;
          additional_directories_json: string;
          updated_at: number;
        }
      | undefined;
    if (!raw) return undefined;
    let parsed: unknown = [];
    try {
      parsed = JSON.parse(raw.additional_directories_json);
    } catch {
      // Corrupt selections fail CLOSED to no additional roots.
    }
    const additionalDirectories = Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
    return {
      conversationId: raw.conversation_id,
      primaryKind: raw.primary_kind,
      additionalDirectories,
      updatedAt: raw.updated_at,
    };
  }

  setWorkspaceSelection(
    conversationId: string,
    primaryKind: ConversationWorkspaceKind,
    additionalDirectories: readonly string[],
    now = Date.now()
  ): void {
    const allowed: readonly ConversationWorkspaceKind[] = [
      "vault-data",
      "app",
      "draft",
    ];
    if (!allowed.includes(primaryKind))
      throw new Error("invalid Centraid workspace kind");
    const selected = [...new Set(additionalDirectories)];
    this.ensureReady()
      .db.prepare(
        `INSERT INTO conversation_workspace_selection (
           conversation_id, primary_kind, additional_directories_json, updated_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           primary_kind = excluded.primary_kind,
           additional_directories_json = excluded.additional_directories_json,
           updated_at = excluded.updated_at`
      )
      .run(conversationId, primaryKind, JSON.stringify(selected), now);
  }

  // ─── turns ──────────────────────────────────────────────────────────

  insertTurn(input: InsertTurnInput): void {
    const { stmts } = this.ensureReady();
    const seqRow = stmts.maxSeq.get(input.conversationId) as { m: number };
    stmts.insertTurn.run(
      input.turnId,
      input.conversationId,
      Number(seqRow.m) + 1,
      input.parentTurnId ?? null,
      input.triggerKind,
      input.triggerOrigin ?? null,
      input.retryOf ?? null,
      input.idempotencyKey ?? null,
      input.note ?? null,
      input.hydrationTokens ?? null,
      input.startedAt
    );
  }

  /** Backs replay-on-duplicate: a re-POST never re-runs the model (#420). */
  getTurnByIdempotencyKey(
    conversationId: string,
    idempotencyKey: string
  ): Turn | undefined {
    const { stmts } = this.ensureReady();
    const raw = stmts.getTurnByIdempotency.get(
      conversationId,
      idempotencyKey
    ) as RawTurn | undefined;
    return raw ? turnFromRaw(raw) : undefined;
  }

  finishTurn(input: FinishTurnInput): void {
    const { stmts } = this.ensureReady();
    stmts.finishTurn.run({
      endedAt: input.endedAt,
      ok: input.ok ? 1 : 0,
      error: input.error ?? null,
      summary: input.summary ?? null,
      outputJson: input.outputJson ?? null,
      tid: input.turnId,
    });
  }

  setTurnHydrationTokens(turnId: string, hydrationTokens: number): void {
    this.ensureReady()
      .db.prepare(
        `UPDATE turns SET hydration_tokens = ? WHERE id = ? AND ended_at IS NOT NULL`
      )
      .run(Math.max(0, Math.floor(hydrationTokens)), turnId);
  }

  getTurn(turnId: string): Turn | undefined {
    const { stmts } = this.ensureReady();
    const raw = stmts.getTurn.get(turnId) as RawTurn | undefined;
    return raw ? turnFromRaw(raw) : undefined;
  }

  /** A FINISHED turn is refused on purpose: `seq` comes from `MAX(seq)+1`, so
   *  deleting the newest hands its `seq` to the next, and
   *  `conversation_archive`'s ranges assume `seq` is monotonic. */
  deleteTurn(turnId: string, userId?: string): boolean {
    const { stmts } = this.ensureReady();
    return (
      Number(
        stmts.deleteTurn.run(turnId, userId ?? null, userId ?? null).changes
      ) > 0
    );
  }

  /** A transcript opens to its TAIL, so that is the end the ceiling keeps;
   *  `limit` is a real ceiling, not a hint (#659). */
  listTurns(conversationId: string, limit = MAX_TRANSCRIPT_TURNS): Turn[] {
    return this.listTurnWindow(conversationId, { limit }).turns;
  }

  /** `beforeSeq` walks STRICTLY backwards, so successive pages never overlap
   *  and never skip; `hasMore` is answered by over-fetching one row rather
   *  than a second COUNT (#659). */
  listTurnWindow(
    conversationId: string,
    options: { limit?: number; beforeSeq?: number } = {}
  ): TurnWindow {
    const { stmts } = this.ensureReady();
    const limit = Math.max(
      1,
      Math.min(options.limit ?? MAX_TRANSCRIPT_TURNS, MAX_TRANSCRIPT_TURNS)
    );
    const beforeSeq = options.beforeSeq ?? null;
    const rows = stmts.listTurnsWindow.all(
      conversationId,
      // Bound twice: the SQL tests the cursor for NULL then compares it, and
      // anonymous placeholders take one value each.
      beforeSeq,
      beforeSeq,
      // One past the window: its presence IS `hasMore`.
      limit + 1
    ) as unknown as RawTurn[];
    // The over-fetched row is the OLDEST of the descending pick.
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(1) : rows;
    const turns = page.map(turnFromRaw);
    return {
      turns,
      hasMore,
      ...(turns.length > 0 ? { oldestSeq: turns[0]!.seq } : {}),
    };
  }

  /** ONE query, replacing `listItems` per turn while folding (#659). */
  listItemsByTurn(
    conversationId: string,
    range: TurnSeqRange = {}
  ): Map<string, Item[]> {
    const { stmts } = this.ensureReady();
    const fromSeq = range.fromSeq ?? null;
    const toSeq = range.toSeq ?? null;
    const rows = stmts.listItemsForConversation.all(
      conversationId,
      fromSeq,
      fromSeq,
      toSeq,
      toSeq
    ) as unknown as RawItem[];
    const byTurn = new Map<string, Item[]>();
    for (const raw of rows) {
      const item = itemFromRaw(raw);
      const bucket = byTurn.get(item.turnId);
      if (bucket) bucket.push(item);
      else byTurn.set(item.turnId, [item]);
    }
    return byTurn;
  }

  /** ONE query: the per-item lookup it replaces was overhead paid once per
   *  rendered message (#659). */
  listAttachmentsByItem(
    conversationId: string,
    range: TurnSeqRange = {}
  ): Map<string, Attachment[]> {
    const { stmts } = this.ensureReady();
    const fromSeq = range.fromSeq ?? null;
    const toSeq = range.toSeq ?? null;
    const rows = stmts.listAttachmentsForConversation.all(
      conversationId,
      fromSeq,
      fromSeq,
      toSeq,
      toSeq
    ) as unknown as RawAttachment[];
    const byItem = new Map<string, Attachment[]>();
    for (const raw of rows) {
      const attachment = attachmentFromRaw(raw);
      const bucket = byItem.get(attachment.itemId);
      if (bucket) bucket.push(attachment);
      else byItem.set(attachment.itemId, [attachment]);
    }
    return byItem;
  }

  listTurnsFiltered(
    conversationId: string,
    opts: ListTurnsOptions = {}
  ): Turn[] {
    const { stmts } = this.ensureReady();
    const limit = opts.limit ?? 50;
    const since = opts.since ?? null;
    const okFilter =
      opts.status === undefined ? null : opts.status === "ok" ? 1 : 0;
    const rows = stmts.listTurnsFiltered.all(
      conversationId,
      since,
      since,
      okFilter,
      okFilter,
      limit
    ) as unknown as RawTurn[];
    return rows.map(turnFromRaw);
  }

  listAutomationTurns(
    automationRef: string,
    opts: ListTurnsOptions = {}
  ): Turn[] {
    const { stmts } = this.ensureReady();
    const limit = opts.limit ?? 50;
    const since = opts.since ?? null;
    const okFilter =
      opts.status === undefined ? null : opts.status === "ok" ? 1 : 0;
    const rows = stmts.listTurnsByAutomation.all(
      automationRef,
      since,
      since,
      okFilter,
      okFilter,
      limit
    ) as unknown as RawTurn[];
    return rows.map(turnFromRaw);
  }

  /** The handle filters apply in SQL, BEFORE `LIMIT` (#731), so a flood on one
   *  handle cannot crowd the window. `excludeAutomationRefs` wins if both. */
  listInFlightAutomationTurns(
    limit = 50,
    opts: {
      excludeAutomationRefs?: readonly string[];
      onlyAutomationRefs?: readonly string[];
    } = {}
  ): Turn[] {
    const { db, stmts } = this.ensureReady();
    const exclude = opts.excludeAutomationRefs;
    const only = opts.onlyAutomationRefs;
    if ((!exclude || exclude.length === 0) && (!only || only.length === 0)) {
      return (
        stmts.listInFlightAutomationTurns.all(limit) as unknown as RawTurn[]
      ).map(turnFromRaw);
    }
    const refs = exclude && exclude.length > 0 ? exclude : (only ?? []);
    const op = exclude && exclude.length > 0 ? "NOT IN" : "IN";
    const placeholders = refs.map(() => "?").join(", ");
    const nullClause = op === "NOT IN" ? "c.automation_id IS NULL OR " : "";
    const rows = db
      .prepare(
        `
        SELECT t.* FROM turns t JOIN conversations c ON t.conversation_id = c.id
        WHERE c.kind = 'automation' AND t.ended_at IS NULL
          AND (${nullClause}c.automation_id ${op} (${placeholders}))
        ORDER BY t.started_at DESC LIMIT ?
      `
      )
      .all(...refs, limit) as unknown as RawTurn[];
    return rows.map(turnFromRaw);
  }

  setTurnPinned(turnId: string, pinned: boolean): void {
    const { stmts } = this.ensureReady();
    stmts.setTurnPinned.run(pinned ? 1 : 0, turnId);
  }

  /** False when the turn isn't in that conversation. */
  setTurnFeedback(
    conversationId: string,
    turnId: string,
    feedback: "up" | "down" | null
  ): boolean {
    const { stmts } = this.ensureReady();
    const info = stmts.setTurnFeedback.run(feedback, turnId, conversationId);
    return Number(info.changes) > 0;
  }

  /** Cascading FKs drop each pruned turn's items; pinned turns survive. */
  pruneAutomation(
    automationRef: string,
    keep: { count?: number; days?: number; errorsOnly?: boolean; all?: boolean }
  ): void {
    const { stmts } = this.ensureReady();
    if (keep.all) return;
    if (keep.errorsOnly) {
      stmts.pruneAutomationErrorsOnly.run(automationRef);
      return;
    }
    if (keep.count !== undefined && keep.count >= 0) {
      stmts.pruneAutomationByCount.run(
        automationRef,
        automationRef,
        keep.count
      );
      return;
    }
    if (keep.days !== undefined && keep.days >= 0) {
      stmts.pruneAutomationByDays.run(
        automationRef,
        Date.now() - keep.days * 24 * 60 * 60 * 1000
      );
    }
  }

  // ─── items ──────────────────────────────────────────────────────────

  insertMessageIn(input: InsertMessageInInput): string {
    const { stmts } = this.ensureReady();
    const itemId = input.itemId ?? randomUUID();
    stmts.insertMessageIn.run(
      itemId,
      input.turnId,
      0,
      input.role,
      input.text,
      input.startedAt
    );
    return itemId;
  }

  insertItem(input: InsertItemInput): void {
    const { stmts } = this.ensureReady();
    stmts.insertItem.run(
      input.itemId,
      input.turnId,
      input.ordinal,
      input.callId ?? null,
      input.batchId ?? null,
      input.kind,
      input.role ?? null,
      input.text ?? null,
      input.model ?? null,
      input.harness ?? null,
      input.effort ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.cacheReadTokens ?? null,
      input.cacheWriteTokens ?? null,
      input.costUsd ?? null,
      input.costSource ?? null,
      input.appId ?? null,
      input.name ?? null,
      input.argsJson ?? null,
      input.outputJson ?? null,
      cappedRawJson(input.rawJson),
      input.childTurnId ?? null,
      input.ok ? 1 : 0,
      input.error ?? null,
      input.startedAt,
      input.endedAt,
      input.durationMs
    );
  }

  openItem(input: OpenItemInput): void {
    const { stmts } = this.ensureReady();
    stmts.openItem.run(
      input.itemId,
      input.turnId,
      input.ordinal,
      input.callId ?? null,
      input.batchId ?? null,
      input.kind,
      input.appId ?? null,
      input.name ?? null,
      input.argsJson ?? null,
      cappedRawJson(input.rawJson),
      input.startedAt
    );
  }

  closeItem(input: CloseItemInput): void {
    const { stmts } = this.ensureReady();
    stmts.closeItem.run({
      ok: input.ok ? 1 : 0,
      outputJson: input.outputJson ?? null,
      rawJson: cappedRawJson(input.rawJson),
      error: input.error ?? null,
      childTurnId: input.childTurnId ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      cacheReadTokens: input.cacheReadTokens ?? null,
      cacheWriteTokens: input.cacheWriteTokens ?? null,
      model: input.model ?? null,
      harness: input.harness ?? null,
      effort: input.effort ?? null,
      costUsd: input.costUsd ?? null,
      costSource: input.costSource ?? null,
      endedAt: input.endedAt,
      durationMs: input.durationMs,
      itemId: input.itemId,
    });
  }

  listItems(turnId: string): Item[] {
    const { stmts } = this.ensureReady();
    const rows = stmts.listItems.all(turnId) as unknown as RawItem[];
    return rows.map(itemFromRaw);
  }

  messageInText(turnId: string): string | undefined {
    const { stmts } = this.ensureReady();
    const row = stmts.messageInText.get(turnId) as
      | { text: string | null }
      | undefined;
    return row?.text ?? undefined;
  }

  // ─── attachments ────────────────────────────────────────────────────

  insertAttachment(input: InsertAttachmentInput): string {
    const { stmts } = this.ensureReady();
    const id = input.id ?? randomUUID();
    stmts.insertAttachment.run(
      id,
      input.itemId,
      input.hash,
      input.mime,
      input.sizeBytes,
      input.source ?? null,
      input.filename ?? null,
      input.workspacePath ?? null,
      Date.now()
    );
    return id;
  }

  listAttachmentsForItem(itemId: string): Attachment[] {
    const { stmts } = this.ensureReady();
    const rows = stmts.listAttachmentsForItem.all(
      itemId
    ) as unknown as RawAttachment[];
    return rows.map(attachmentFromRaw);
  }

  listAttachmentsForTurn(turnId: string): Attachment[] {
    const { stmts } = this.ensureReady();
    const rows = stmts.listAttachmentsForTurn.all(
      turnId
    ) as unknown as RawAttachment[];
    return rows.map(attachmentFromRaw);
  }

  referencedHashes(): Set<string> {
    const { stmts } = this.ensureReady();
    const rows = stmts.referencedHashes.all() as unknown as { hash: string }[];
    return new Set(rows.map((r) => r.hash));
  }

  /** `pruned` ⇒ the raw turns are gone and the caller rehydrates from the
   *  segment blob (#438). */
  listArchiveSegments(conversationId: string): ArchiveSegmentRef[] {
    const { stmts } = this.ensureReady();
    const rows = stmts.listArchiveSegments.all(conversationId) as unknown as {
      id: string;
      seq_from: number;
      seq_to: number;
      segment_sha256: string;
      pruned_at: number | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      seqFrom: r.seq_from,
      seqTo: r.seq_to,
      segmentSha256: r.segment_sha256,
      pruned: r.pruned_at !== null,
    }));
  }

  // ─── automation state KV ────────────────────────────────────────────

  stateGet(
    automationId: string,
    key: string
  ): AutomationStateEntry | undefined {
    const { stmts } = this.ensureReady();
    const raw = stmts.getState.get(automationId, key) as RawState | undefined;
    return raw ? stateFromRaw(raw) : undefined;
  }

  stateSet(
    automationId: string,
    key: string,
    valueJson: string,
    updatedAt: number
  ): void {
    const { stmts } = this.ensureReady();
    stmts.upsertState.run(automationId, key, valueJson, updatedAt);
  }

  stateDelete(automationId: string, key: string): void {
    const { stmts } = this.ensureReady();
    stmts.deleteState.run(automationId, key);
  }

  /** A NO-OP close: the connection is the host's and shared. */
  close(): void {
    this.db = undefined;
    this.stmts = undefined;
  }
}
