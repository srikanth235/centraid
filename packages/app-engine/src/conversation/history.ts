/*
 * Centraid conversation-history facade — the conversation-container API +
 * transcript fold, over the per-vault `ConversationStore` (issue #98, reshaped
 * by #190, vault-scoped by #280). This is the read/write API the interactive
 * chat surface uses; the store is conversation-first (it spans `kind='chat'`
 * and `'build'`), while the HTTP route it's exposed over stays the
 * `/_centraid-conversations` wire surface.
 *
 * A chat session IS a `conversations` row (`kind='chat'` | `'build'`).
 * Conversations + their turns/items/attachments live in the ACTIVE vault's
 * `transcripts.db` — a conversation binds to its vault at creation, so
 * switching vaults switches the visible history, and a mid-thread switch
 * fails closed (the thread's row isn't in the new vault's file). App scoping
 * is the `app_id` column. Conversations are stamped with the vault owner's
 * party id — the vault owner IS the user (#280).
 *
 * The transcript is NOT its own table. A chat turn is a `turns` row; the
 * turn's inbound message is its ordinal-0 `message_in` item, and the
 * assistant text + tool calls are the remaining `items` (issue #190 fold).
 * `recordTurn` writes that trace; `getSession` reconstructs the renderer
 * transcript uniformly from items. Exposed over HTTP at `/_centraid-conversations`.
 */

import { randomUUID } from 'node:crypto';
import type { WorkspaceProvider } from '../stores/vault-workspace.js';
import { ConversationStore, type ConversationMeta } from './store.js';
import type { RunKind } from './schema.js';
import type { RunSummarySink } from './run-summary-sink.js';
import { isValidAppId } from '../registry/app-paths.js';
import { costForUsage } from '../model-pricing.js';
import { parseStepOutput, parseToolArgs, parseToolOutput } from './transcript.js';
import { BlobStore, blobUrl, type PutResult } from '../data/blob-store.js';

export interface ConversationSummary {
  id: string;
  /** Owner of the session — the gateway-side user UUID from `UserStore`. */
  userId: string;
  title: string;
  /** Runner kind that owns `adapterSessionId` (codex | claude-code | openclaw). */
  adapterKind: string | null;
  /** Opaque per-runner resume handle; `null` until the first turn lands. */
  adapterSessionId: string | null;
  /** Number of completed turns on this session. */
  turnCount: number;
  createdAt: number;
  updatedAt: number;
  /** Reconstructed transcript length (user + assistant + tool messages). */
  messageCount: number;
}

export interface ConversationMessageRow {
  idx: number;
  payload: unknown;
  createdAt: number;
}

/** A file already landed in the blob CAS, to attach to a turn's inbound message. */
export interface ConversationTurnAttachment {
  hash: string;
  mime: string;
  sizeBytes: number;
  filename?: string;
  /** Defaults to `'upload'`. */
  source?: string;
}

/**
 * One item of a completed chat turn, handed to `recordTurn`. The chat route
 * accumulates these from the runner's `TurnStreamEvent`s.
 */
export type TurnNode =
  | {
      kind: 'step';
      /** Accumulated assistant text for the turn. */
      text: string;
      /** True when this step carries a runner/turn error message. */
      isError?: boolean;
      model?: string;
      provider?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      startedAt: number;
      endedAt: number;
    }
  | {
      kind: 'tool';
      toolName: string;
      sql?: string;
      args?: unknown;
      ok: boolean;
      result?: unknown;
      errorText?: string;
      appId?: string;
      startedAt: number;
      endedAt: number;
    };

export interface RecordTurnInput {
  conversationId: string;
  /**
   * The conversation kind. A builder-surface turn is `'build'`; a data chat is
   * `'chat'` (the default). Set on the conversation the first time it differs
   * — a thread is single-kind (issue #190).
   */
  kind?: RunKind;
  /** The user's prompt for the turn — recorded as the `message_in` item. */
  userMessage: string;
  /** Files that rode in on this turn's inbound message (already in the CAS). */
  attachments?: ConversationTurnAttachment[];
  startedAt: number;
  endedAt: number;
  ok: boolean;
  error?: string;
  /** The assistant's final reply text (the turn's terminal output). */
  finalText?: string;
  /** The turn's ordered trace (assistant steps + tool calls). */
  nodes: TurnNode[];
}

export class ConversationHistoryStore {
  private readonly workspace: WorkspaceProvider;
  /**
   * ONE ledger store over "the ACTIVE vault's transcripts.db" — the provider
   * resolves the workspace per call and the store re-prepares on handle
   * change, so a vault switch needs no reconstruction here.
   */
  private readonly store: ConversationStore;
  /** Blob CAS for attachment bytes — rooted at the active workspace (#190/#280). */
  private readonly blobs: BlobStore;

  /**
   * `analytics`, when set, threads into the `ConversationStore` so a chat
   * turn's `finishTurn` write-throughs a `run_summary` row (same file).
   */
  constructor(workspace: WorkspaceProvider, analytics?: RunSummarySink) {
    this.workspace = workspace;
    this.store = new ConversationStore(() => workspace().transcripts(), analytics);
    this.blobs = new BlobStore(() => workspace().appsDir);
  }

  private appConversation(appId: string): { store: ConversationStore } {
    if (!isValidAppId(appId)) throw new Error(`conversation-history: invalid app id "${appId}"`);
    return { store: this.store };
  }

  /** The vault owner's party id — the one user identity that exists (#280). */
  private currentUserId(): string {
    return this.workspace().ownerPartyId;
  }

  /**
   * Resolve a conversation ONLY when `appId` owns it. The ledger file is
   * per-vault now (#280), so the per-app isolation the file boundary used
   * to give is enforced here: a cross-app id lookup reads as not-found.
   */
  private ownedMeta(appId: string, id: string): ConversationMeta | undefined {
    const meta = this.store.getConversationMeta(id, this.currentUserId());
    if (!meta || meta.appId !== appId) return undefined;
    return meta;
  }

  listSessions(appId: string): ConversationSummary[] {
    const { store } = this.appConversation(appId);
    return store.listConversationsMeta(this.currentUserId(), appId).map(toMeta);
  }

  /** Create a fresh chat session in `appId`. */
  createSession(appId: string, title: string = '', kind: RunKind = 'chat'): ConversationSummary {
    const { store } = this.appConversation(appId);
    const conv = store.createConversation({
      kind,
      userId: this.currentUserId(),
      appId,
      title,
    });
    return toMeta({ ...conv, messageCount: 0 });
  }

  /**
   * Load a session with its transcript reconstructed uniformly from the
   * conversation's items: each turn contributes its ordinal-0 `message_in`
   * item as a `user` message (with any attachments), then `step` items as
   * `ai` messages and `tool` items as `tool` messages (issue #190).
   */
  getSession(
    appId: string,
    id: string,
  ): (ConversationSummary & { messages: ConversationMessageRow[] }) | undefined {
    const { store } = this.appConversation(appId);
    const meta = this.ownedMeta(appId, id);
    if (!meta) return undefined;

    const messages: ConversationMessageRow[] = [];
    let idx = 0;
    for (const turn of store.listTurns(id)) {
      for (const item of store.listItems(turn.turnId)) {
        if (item.kind === 'message_in') {
          const attachments = this.attachmentsPayload(appId, item.itemId);
          messages.push({
            idx: idx++,
            payload: {
              kind: 'user',
              text: item.text ?? '',
              ...(attachments.length > 0 ? { attachments } : {}),
            },
            createdAt: item.startedAt,
          });
        } else if (item.kind === 'step') {
          const parsed = parseStepOutput(item.outputJson);
          messages.push({
            idx: idx++,
            payload: { kind: 'ai', text: parsed.text, ...(parsed.error ? { error: true } : {}) },
            createdAt: item.startedAt,
          });
        } else if (item.kind === 'tool') {
          const args = parseToolArgs(item.argsJson);
          const out = parseToolOutput(item.outputJson);
          messages.push({
            idx: idx++,
            payload: {
              kind: 'tool',
              id: item.itemId,
              tool: item.name ?? 'tool',
              ...(args.sql !== undefined ? { sql: args.sql } : {}),
              ...(args.args !== undefined ? { args: args.args } : {}),
              state: item.ok ? 'ok' : 'error',
              ...(out.result !== undefined ? { result: out.result } : {}),
              ...(out.errorText !== undefined ? { errorText: out.errorText } : {}),
            },
            createdAt: item.startedAt,
          });
        }
      }
    }
    return { ...toMeta(meta), messageCount: messages.length, messages };
  }

  /** Attachment metadata + download URL for a message item's attachments. */
  private attachmentsPayload(appId: string, itemId: string): unknown[] {
    const { store } = this.appConversation(appId);
    return store.listAttachmentsForItem(itemId).map((a) => ({
      id: a.id,
      mime: a.mime,
      sizeBytes: a.sizeBytes,
      ...(a.filename !== undefined ? { filename: a.filename } : {}),
      url: blobUrl(appId, a.hash),
    }));
  }

  /** Persist uploaded bytes to the app's blob CAS (dedup by content hash). */
  uploadBlob(appId: string, bytes: Uint8Array): Promise<PutResult> {
    return this.blobs.put(appId, bytes);
  }

  /** Read attachment bytes back from the CAS (for the download route). */
  readBlob(appId: string, hash: string): Promise<Buffer | undefined> {
    return this.blobs.read(appId, hash);
  }

  /** Absolute on-disk path of a blob — the multimodal adapter reads it. */
  blobPathFor(appId: string, hash: string): string {
    return this.blobs.pathFor(appId, hash);
  }

  getSessionMeta(appId: string, id: string): ConversationSummary | undefined {
    const meta = this.ownedMeta(appId, id);
    return meta ? toMeta(meta) : undefined;
  }

  renameSession(appId: string, id: string, title: string): ConversationSummary | undefined {
    const { store } = this.appConversation(appId);
    if (!this.ownedMeta(appId, id)) return undefined;
    if (!store.renameConversation(id, this.currentUserId(), title)) return undefined;
    return this.getSessionMeta(appId, id);
  }

  deleteSession(appId: string, id: string): boolean {
    // Real FK CASCADE drops the conversation's turns, items, and attachment
    // rows; a follow-up blob GC reclaims now-unreferenced bytes (issue #190).
    const { store } = this.appConversation(appId);
    if (!this.ownedMeta(appId, id)) return false;
    const ok = store.deleteConversation(id, this.currentUserId());
    if (ok) void this.blobs.gc(appId, store.referencedHashes()).catch(() => undefined);
    return ok;
  }

  /**
   * Persist one completed chat turn: a `turns` row, its ordinal-0 `message_in`
   * item (plus any attachments), and the assistant/tool `items`, in the active
   * vault's `transcripts.db`. Returns `undefined` when the conversation doesn't
   * exist there — including the mid-turn vault-switch case, which thereby fails
   * closed (#280) — or is owned by another user. The first turn names the
   * conversation.
   */
  recordTurn(appId: string, input: RecordTurnInput): { turnId: string } | undefined {
    const { store } = this.appConversation(appId);
    const userId = this.currentUserId();
    if (!this.ownedMeta(appId, input.conversationId)) return undefined;
    const existingTitle = store.titleOf(input.conversationId, userId);
    if (existingTitle === undefined) return undefined;

    const turnId = randomUUID();
    store.runInTransaction(() => {
      if (input.kind && input.kind !== 'chat') {
        store.setKind(input.conversationId, userId, input.kind);
      }
      store.insertTurn({
        turnId,
        conversationId: input.conversationId,
        triggerKind: 'interactive',
        startedAt: input.startedAt,
      });
      const messageItemId = store.insertMessageIn({
        turnId,
        role: 'user',
        text: input.userMessage,
        startedAt: input.startedAt,
      });
      for (const att of input.attachments ?? []) {
        store.insertAttachment({
          itemId: messageItemId,
          hash: att.hash,
          mime: att.mime,
          sizeBytes: att.sizeBytes,
          source: att.source ?? 'upload',
          ...(att.filename !== undefined ? { filename: att.filename } : {}),
        });
      }
      // Trace items start at ordinal 1 — the inbound message is ordinal 0.
      input.nodes.forEach((node, i) => recordNode(store, turnId, i + 1, node));
      store.finishTurn({
        turnId,
        endedAt: input.endedAt,
        ok: input.ok,
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.finalText !== undefined
          ? { outputJson: JSON.stringify({ text: input.finalText }) }
          : {}),
      });
      const now = Date.now();
      if (!existingTitle) {
        store.setTitle(input.conversationId, userId, deriveTitle(input.userMessage), now);
      } else {
        store.touchConversation(input.conversationId, userId, now);
      }
    });
    return { turnId };
  }

  /** Bump turn_count + persist the runner-resume handle. */
  noteTurn(
    appId: string,
    sessionId: string,
    adapter?: { kind: string; sessionId?: string },
  ): ConversationSummary | undefined {
    const { store } = this.appConversation(appId);
    if (!this.ownedMeta(appId, sessionId)) return undefined;
    if (!store.noteTurn(sessionId, this.currentUserId(), adapter)) return undefined;
    return this.getSessionMeta(appId, sessionId);
  }
}

function recordNode(
  store: ConversationStore,
  turnId: string,
  ordinal: number,
  node: TurnNode,
): void {
  if (node.kind === 'step') {
    // Freeze the per-call cost at write time — NULL when the model is unknown.
    const cost = costForUsage(node.model, {
      ...(node.inputTokens !== undefined ? { inputTokens: node.inputTokens } : {}),
      ...(node.outputTokens !== undefined ? { outputTokens: node.outputTokens } : {}),
      ...(node.cacheReadTokens !== undefined ? { cacheReadTokens: node.cacheReadTokens } : {}),
      ...(node.cacheWriteTokens !== undefined ? { cacheWriteTokens: node.cacheWriteTokens } : {}),
    });
    store.insertItem({
      itemId: randomUUID(),
      turnId,
      ordinal,
      kind: 'step',
      outputJson: JSON.stringify({ text: node.text, ...(node.isError ? { error: true } : {}) }),
      ok: !node.isError,
      ...(node.model !== undefined ? { model: node.model } : {}),
      ...(node.provider !== undefined ? { provider: node.provider } : {}),
      ...(node.inputTokens !== undefined ? { inputTokens: node.inputTokens } : {}),
      ...(node.outputTokens !== undefined ? { outputTokens: node.outputTokens } : {}),
      ...(node.cacheReadTokens !== undefined ? { cacheReadTokens: node.cacheReadTokens } : {}),
      ...(node.cacheWriteTokens !== undefined ? { cacheWriteTokens: node.cacheWriteTokens } : {}),
      ...(cost !== undefined ? { costUsd: cost } : {}),
      startedAt: node.startedAt,
      endedAt: node.endedAt,
      durationMs: Math.max(0, node.endedAt - node.startedAt),
    });
  } else {
    store.insertItem({
      itemId: randomUUID(),
      turnId,
      ordinal,
      kind: 'tool',
      name: node.toolName,
      argsJson: JSON.stringify({
        ...(node.sql !== undefined ? { sql: node.sql } : {}),
        ...(node.args !== undefined ? { args: node.args } : {}),
      }),
      outputJson: JSON.stringify({
        ...(node.result !== undefined ? { result: node.result } : {}),
        ...(node.errorText !== undefined ? { errorText: node.errorText } : {}),
      }),
      ok: node.ok,
      ...(node.errorText !== undefined ? { error: node.errorText } : {}),
      ...(node.appId !== undefined ? { appId: node.appId } : {}),
      startedAt: node.startedAt,
      endedAt: node.endedAt,
      durationMs: Math.max(0, node.endedAt - node.startedAt),
    });
  }
}

function toMeta(c: ConversationMeta): ConversationSummary {
  return {
    id: c.id,
    userId: c.userId,
    title: c.title,
    adapterKind: c.adapterKind ?? null,
    adapterSessionId: c.adapterSessionId ?? null,
    turnCount: c.turnCount,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    messageCount: c.messageCount,
  };
}

export function deriveTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return '';
  if (cleaned.length <= 60) return cleaned;
  return `${cleaned.slice(0, 57)}…`;
}

// HTTP route dispatcher lives in conversation-routes.ts to keep this file
// focused on the facade + fold. Re-exported below from the package index.
