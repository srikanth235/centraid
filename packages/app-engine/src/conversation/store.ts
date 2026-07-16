// governance: allow-repo-hygiene file-size-limit #190 — one cohesive
// ConversationStore class; its SQL + row mappers are already split into
// store-sql.ts and the row types into schema.ts.
/*
 * ConversationStore — the per-vault conversation ledger + automation KV
 * (issue #90, reshaped by #190; moved from per-app `runtime.sqlite` into
 * the vault's `journal.db` by #280 — a conversation binds to its vault
 * at creation, and app scoping is the `app_id` column, not a file).
 *
 * Five ledger tables — `conversations`, `turns`, `items`, `attachments`,
 * `automation_state` — the `CONVERSATION_LEDGER_DDL` shape in `gateway-db.ts`
 * (which also carries the `run_summary` view `AnalyticsStore` reads).
 *
 *   conversations    — the first-class durable record. `kind` (chat |
 *                      automation | build), `app_id`, `automation_id` live
 *                      here. Each automation has one stable conversation
 *                      (`id=automation_id=<ref>`); fires and compiles append turns.
 *   turns            — one execution under a conversation (chat turn /
 *                      automation fire / builder iteration). NOT NULL,
 *                      FK-backed `conversation_id`. Carries the token/cost
 *                      rollup written at finish.
 *   items            — the ordered trace, including the inbound `message_in`
 *                      (ordinal 0). `step` is one model call; `tool`/`agent`
 *                      are per-call audit rows.
 *   attachments      — files riding an inbound message (chat upload OR
 *                      webhook/email file), CASCADE off `items`.
 *   automation_state — per-(automation_id, key) KV.
 *
 * Constructed over a vault's `journal.db` `DatabaseProvider` (which may
 * resolve "the ACTIVE vault" — the store re-prepares when the handle
 * changes). Runtime-owned: never reachable from the handler `db` proxy or
 * the `centraid_sql_*` agent tools. The `run_summary` Insights source is a
 * VIEW over these tables (see `CONVERSATION_LEDGER_DDL`) — `finishTurn`
 * needs no write-through; a finished turn simply appears in the view.
 *
 * Row types live in `schema.ts`; the prepared-statement block +
 * raw-row mappers live in `store-sql.ts`.
 */

import { randomUUID } from 'node:crypto';
import { type DatabaseSync } from 'node:sqlite';
import type { DatabaseProvider } from '../stores/gateway-db.js';
import type {
  Conversation,
  Turn,
  Item,
  Attachment,
  AutomationStateEntry,
  AutomationTriggerKind,
  AutomationTriggerOrigin,
  ItemKind,
  RunKind,
} from './schema.js';
import {
  prepare,
  conversationFromRaw,
  turnFromRaw,
  itemFromRaw,
  attachmentFromRaw,
  stateFromRaw,
  type PreparedStatements,
  type RawConversation,
  type RawTurn,
  type RawItem,
  type RawAttachment,
  type RawState,
} from './store-sql.js';

export interface CreateConversationInput {
  /** Defaults to a fresh UUID. Automation conversations use the stable ref. */
  readonly id?: string;
  readonly kind: RunKind;
  readonly userId: string;
  readonly appId?: string;
  readonly automationId?: string;
  readonly title?: string;
}

export interface InsertTurnInput {
  readonly turnId: string;
  readonly conversationId: string;
  readonly triggerKind: AutomationTriggerKind;
  readonly triggerOrigin?: AutomationTriggerOrigin;
  readonly parentTurnId?: string;
  readonly retryOf?: string;
  readonly note?: string;
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
  /** Defaults to a fresh UUID — returned so attachments can FK to it. */
  readonly itemId?: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly startedAt: number;
}

export interface InsertItemInput {
  readonly itemId: string;
  readonly turnId: string;
  readonly ordinal: number;
  readonly batchId?: number;
  readonly kind: ItemKind;
  readonly role?: 'user' | 'assistant';
  readonly text?: string;
  readonly name?: string;
  readonly argsJson?: string;
  readonly outputJson?: string;
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
  readonly provider?: string;
  readonly costUsd?: number;
  readonly appId?: string;
}

/** Insert a durable "running" item (issue #158); `closeItem` settles it. */
export interface OpenItemInput {
  readonly itemId: string;
  readonly turnId: string;
  readonly ordinal: number;
  readonly batchId?: number;
  readonly kind: ItemKind;
  readonly name?: string;
  readonly argsJson?: string;
  readonly appId?: string;
  readonly startedAt: number;
}

export interface CloseItemInput {
  readonly itemId: string;
  readonly ok: boolean;
  readonly outputJson?: string;
  readonly error?: string;
  readonly childTurnId?: string;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly model?: string;
  readonly provider?: string;
  readonly costUsd?: number;
}

export interface InsertAttachmentInput {
  readonly id?: string;
  readonly itemId: string;
  readonly hash: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly source?: string;
  readonly filename?: string;
}

export interface ListTurnsOptions {
  readonly status?: 'ok' | 'error';
  readonly since?: number;
  readonly limit?: number;
}

/** `Conversation` plus its reconstructed transcript length. */
export type ConversationMeta = Conversation & { readonly messageCount: number };

export class ConversationStore {
  private readonly provider: DatabaseProvider;
  private db: DatabaseSync | undefined;
  private stmts: PreparedStatements | undefined;

  constructor(provider: DatabaseProvider) {
    this.provider = provider;
  }

  private ensureReady(): { db: DatabaseSync; stmts: PreparedStatements } {
    // The provider may resolve a different handle across calls (the gateway
    // wires "the ACTIVE vault's journal.db") — re-prepare on change so a
    // vault switch lands without reconstructing the store.
    const db = this.provider();
    if (this.db === db && this.stmts) return { db, stmts: this.stmts };
    const stmts = prepare(db);
    this.db = db;
    this.stmts = stmts;
    return { db, stmts };
  }

  /** Run `fn` inside one `IMMEDIATE` transaction; rolls back on throw. */
  runInTransaction<T>(fn: () => T): T {
    const { db } = this.ensureReady();
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
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
      input.title ?? '',
      now,
      now,
    );
    return {
      id,
      kind: input.kind,
      userId: input.userId,
      ...(input.appId !== undefined ? { appId: input.appId } : {}),
      ...(input.automationId !== undefined ? { automationId: input.automationId } : {}),
      title: input.title ?? '',
      turnCount: 0,
      pinned: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Ensure the one long-lived conversation for an automation and refresh its title. */
  ensureAutomationConversation(automationRef: string, appId?: string, name?: string): string {
    const existing = this.getConversation(automationRef);
    if (!existing) {
      this.createConversation({
        id: automationRef,
        kind: 'automation',
        userId: '',
        automationId: automationRef,
        ...(appId !== undefined ? { appId } : {}),
        ...(name !== undefined ? { title: name } : {}),
      });
      return automationRef;
    }
    if (existing.kind !== 'automation' || existing.automationId !== automationRef) {
      throw new Error(`conversation id collision for automation "${automationRef}"`);
    }
    const { stmts } = this.ensureReady();
    stmts.updateAutomationConversation.run(
      appId ?? null,
      name ?? null,
      Date.now(),
      automationRef,
      automationRef,
    );
    return automationRef;
  }

  /** @deprecated Use ensureAutomationConversation. */
  createAutomationRun(
    _conversationId: string,
    automationRef: string,
    appId?: string,
    name?: string,
  ): void {
    this.ensureAutomationConversation(automationRef, appId, name);
  }

  getConversation(id: string): Conversation | undefined {
    const { stmts } = this.ensureReady();
    const raw = stmts.getConversation.get(id) as RawConversation | undefined;
    return raw ? conversationFromRaw(raw) : undefined;
  }

  getConversationMeta(id: string, userId: string): ConversationMeta | undefined {
    const { stmts } = this.ensureReady();
    const raw = stmts.getConversationWithCount.get(id, userId) as
      | (RawConversation & { msg_count: number })
      | undefined;
    if (!raw) return undefined;
    return { ...conversationFromRaw(raw), messageCount: Number(raw.msg_count) };
  }

  /**
   * Chat/build threads for a user, newest-first. `appId` scopes to one app —
   * the ledger file is per VAULT (#280), so app scoping is a column filter
   * now, not a file boundary.
   */
  listConversationsMeta(userId: string, appId?: string): ConversationMeta[] {
    const { stmts } = this.ensureReady();
    const rows = stmts.listConversations.all(
      userId,
      appId ?? null,
      appId ?? null,
    ) as unknown as (RawConversation & {
      msg_count: number;
    })[];
    return rows.map((r) => ({ ...conversationFromRaw(r), messageCount: Number(r.msg_count) }));
  }

  renameConversation(id: string, userId: string, title: string): boolean {
    const { stmts } = this.ensureReady();
    return Number(stmts.renameConversation.run(title, Date.now(), id, userId).changes) > 0;
  }

  /** Delete a conversation (user-scoped). Turns / items / attachments cascade. */
  deleteConversation(id: string, userId: string): boolean {
    const { stmts } = this.ensureReady();
    return Number(stmts.deleteConversationForUser.run(id, userId).changes) > 0;
  }

  /** Delete the automation's one conversation + its state. Cascades. */
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

  /** Bump turn_count + updated_at; optionally persist the runner-resume handle. */
  noteTurn(id: string, userId: string, adapter?: { kind: string; sessionId?: string }): boolean {
    const { stmts } = this.ensureReady();
    const now = Date.now();
    let res;
    if (adapter && adapter.sessionId !== undefined) {
      res = stmts.noteTurnWithAdapter.run(now, adapter.kind, adapter.sessionId, id, userId);
    } else if (adapter) {
      res = stmts.noteTurnKindOnly.run(now, adapter.kind, id, userId);
    } else {
      res = stmts.noteTurnNoAdapter.run(now, id, userId);
    }
    return Number(res.changes) > 0;
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
      input.note ?? null,
      input.startedAt,
    );
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

  getTurn(turnId: string): Turn | undefined {
    const { stmts } = this.ensureReady();
    const raw = stmts.getTurn.get(turnId) as RawTurn | undefined;
    return raw ? turnFromRaw(raw) : undefined;
  }

  /** Every turn of a conversation, oldest-first (seq ASC) — the thread's turns. */
  listTurns(conversationId: string): Turn[] {
    const { stmts } = this.ensureReady();
    const rows = stmts.listTurnsAsc.all(conversationId) as unknown as RawTurn[];
    return rows.map(turnFromRaw);
  }

  /** Newest-first, filtered turns of a conversation — the activity feed. */
  listTurnsFiltered(conversationId: string, opts: ListTurnsOptions = {}): Turn[] {
    const { stmts } = this.ensureReady();
    const limit = opts.limit ?? 50;
    const since = opts.since ?? null;
    const okFilter = opts.status === undefined ? null : opts.status === 'ok' ? 1 : 0;
    const rows = stmts.listTurnsFiltered.all(
      conversationId,
      since,
      since,
      okFilter,
      okFilter,
      limit,
    ) as unknown as RawTurn[];
    return rows.map(turnFromRaw);
  }

  /**
   * An automation's history — every turn in its stable conversation, newest-first. The
   * handler-facing `ctx.runs` feed and any "recent runs" view read this.
   */
  listAutomationTurns(automationRef: string, opts: ListTurnsOptions = {}): Turn[] {
    const { stmts } = this.ensureReady();
    const limit = opts.limit ?? 50;
    const since = opts.since ?? null;
    const okFilter = opts.status === undefined ? null : opts.status === 'ok' ? 1 : 0;
    const rows = stmts.listTurnsByAutomation.all(
      automationRef,
      since,
      since,
      okFilter,
      okFilter,
      limit,
    ) as unknown as RawTurn[];
    return rows.map(turnFromRaw);
  }

  /** Every currently executing automation turn across the vault, newest-first. */
  listInFlightAutomationTurns(limit = 50): Turn[] {
    const { stmts } = this.ensureReady();
    return (stmts.listInFlightAutomationTurns.all(limit) as unknown as RawTurn[]).map(turnFromRaw);
  }

  setTurnPinned(turnId: string, pinned: boolean): void {
    const { stmts } = this.ensureReady();
    stmts.setTurnPinned.run(pinned ? 1 : 0, turnId);
  }

  /**
   * Set (or clear, with `null`) the reader's 👍/👎 on one turn's answer, scoped
   * to its conversation (issue #420). Returns whether a row was updated — false
   * when the turn isn't in that conversation.
   */
  setTurnFeedback(conversationId: string, turnId: string, feedback: 'up' | 'down' | null): boolean {
    const { stmts } = this.ensureReady();
    const info = stmts.setTurnFeedback.run(feedback, turnId, conversationId);
    return Number(info.changes) > 0;
  }

  /**
   * Apply `history.keep` at turn grain within the stable conversation. Cascading
   * FKs drop each pruned turn's items + attachments; pinned turns survive.
   */
  pruneAutomation(
    automationRef: string,
    keep: { count?: number; days?: number; errorsOnly?: boolean; all?: boolean },
  ): void {
    const { stmts } = this.ensureReady();
    if (keep.all) return;
    if (keep.errorsOnly) {
      stmts.pruneAutomationErrorsOnly.run(automationRef);
      return;
    }
    if (keep.count !== undefined && keep.count >= 0) {
      stmts.pruneAutomationByCount.run(automationRef, automationRef, keep.count);
      return;
    }
    if (keep.days !== undefined && keep.days >= 0) {
      stmts.pruneAutomationByDays.run(automationRef, Date.now() - keep.days * 24 * 60 * 60 * 1000);
    }
  }

  // ─── items ──────────────────────────────────────────────────────────

  /** Record the inbound message as ordinal 0; returns the item id for attachments. */
  insertMessageIn(input: InsertMessageInInput): string {
    const { stmts } = this.ensureReady();
    const itemId = input.itemId ?? randomUUID();
    stmts.insertMessageIn.run(itemId, input.turnId, 0, input.role, input.text, input.startedAt);
    return itemId;
  }

  insertItem(input: InsertItemInput): void {
    const { stmts } = this.ensureReady();
    stmts.insertItem.run(
      input.itemId,
      input.turnId,
      input.ordinal,
      input.batchId ?? null,
      input.kind,
      input.role ?? null,
      input.text ?? null,
      input.model ?? null,
      input.provider ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.cacheReadTokens ?? null,
      input.cacheWriteTokens ?? null,
      input.costUsd ?? null,
      input.appId ?? null,
      input.name ?? null,
      input.argsJson ?? null,
      input.outputJson ?? null,
      input.childTurnId ?? null,
      input.ok ? 1 : 0,
      input.error ?? null,
      input.startedAt,
      input.endedAt,
      input.durationMs,
    );
  }

  openItem(input: OpenItemInput): void {
    const { stmts } = this.ensureReady();
    stmts.openItem.run(
      input.itemId,
      input.turnId,
      input.ordinal,
      input.batchId ?? null,
      input.kind,
      input.appId ?? null,
      input.name ?? null,
      input.argsJson ?? null,
      input.startedAt,
    );
  }

  closeItem(input: CloseItemInput): void {
    const { stmts } = this.ensureReady();
    stmts.closeItem.run({
      ok: input.ok ? 1 : 0,
      outputJson: input.outputJson ?? null,
      error: input.error ?? null,
      childTurnId: input.childTurnId ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      cacheReadTokens: input.cacheReadTokens ?? null,
      cacheWriteTokens: input.cacheWriteTokens ?? null,
      model: input.model ?? null,
      provider: input.provider ?? null,
      costUsd: input.costUsd ?? null,
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

  /** The turn's inbound `message_in` payload text, if any. */
  messageInText(turnId: string): string | undefined {
    const { stmts } = this.ensureReady();
    const row = stmts.messageInText.get(turnId) as { text: string | null } | undefined;
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
      Date.now(),
    );
    return id;
  }

  listAttachmentsForItem(itemId: string): Attachment[] {
    const { stmts } = this.ensureReady();
    const rows = stmts.listAttachmentsForItem.all(itemId) as unknown as RawAttachment[];
    return rows.map(attachmentFromRaw);
  }

  listAttachmentsForTurn(turnId: string): Attachment[] {
    const { stmts } = this.ensureReady();
    const rows = stmts.listAttachmentsForTurn.all(turnId) as unknown as RawAttachment[];
    return rows.map(attachmentFromRaw);
  }

  /** Every blob hash still referenced by an attachment row — the GC live set. */
  referencedHashes(): Set<string> {
    const { stmts } = this.ensureReady();
    const rows = stmts.referencedHashes.all() as unknown as { hash: string }[];
    return new Set(rows.map((r) => r.hash));
  }

  // ─── automation state KV ────────────────────────────────────────────

  stateGet(automationId: string, key: string): AutomationStateEntry | undefined {
    const { stmts } = this.ensureReady();
    const raw = stmts.getState.get(automationId, key) as RawState | undefined;
    return raw ? stateFromRaw(raw) : undefined;
  }

  stateSet(automationId: string, key: string, valueJson: string, updatedAt: number): void {
    const { stmts } = this.ensureReady();
    stmts.upsertState.run(automationId, key, valueJson, updatedAt);
  }

  stateDelete(automationId: string, key: string): void {
    const { stmts } = this.ensureReady();
    stmts.deleteState.run(automationId, key);
  }

  /**
   * No-op close. The connection is owned by the host's `DatabaseProvider`
   * and shared with the other gateway-state stores; only the cached prepared
   * statements are cleared.
   */
  close(): void {
    this.db = undefined;
    this.stmts = undefined;
  }
}
