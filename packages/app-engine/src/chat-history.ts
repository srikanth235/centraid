/*
 * Centraid chat facade — the conversation-container API + transcript fold,
 * over the per-app `ConversationStore` (issue #98, reshaped by #190).
 *
 * A chat session IS a `conversations` row (`kind='chat'` | `'build'`). Chat is
 * app-scoped: conversations + their turns/items/attachments live in the owning
 * app's per-app `runtime.sqlite`. One `ChatHistoryStore` fronts every app;
 * each method takes the `appId` and resolves `<appsDir>/<appId>/runtime.sqlite`
 * lazily, caching one `ConversationStore` per app. Conversations are scoped by
 * the gateway-side user UUID (`UserStore.getUserId`).
 *
 * The transcript is NOT its own table. A chat turn is a `turns` row; the
 * turn's inbound message is its ordinal-0 `message_in` item, and the
 * assistant text + tool calls are the remaining `items` (issue #190 fold).
 * `recordTurn` writes that trace; `getSession` reconstructs the renderer
 * transcript uniformly from items. Exposed over HTTP at `/_centraid-chat`.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeRuntimeDbProvider } from './gateway-db.js';
import { ConversationStore, type ConversationMeta } from './agent-runs-store.js';
import type { RunKind } from './agent-runs-schema.js';
import type { RunSummarySink } from './run-summary-sink.js';
import { isValidAppId } from './app-paths.js';
import { costForUsage } from './model-pricing.js';
import { parseStepOutput, parseToolArgs, parseToolOutput } from './chat-transcript.js';
import { BlobStore, blobUrl, type PutResult } from './blob-store.js';

export interface ChatSessionMeta {
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

export interface ChatMessageRow {
  idx: number;
  payload: unknown;
  createdAt: number;
}

/** A file already landed in the blob CAS, to attach to a turn's inbound message. */
export interface ChatTurnAttachment {
  hash: string;
  mime: string;
  sizeBytes: number;
  filename?: string;
  /** Defaults to `'upload'`. */
  source?: string;
}

/**
 * One item of a completed chat turn, handed to `recordTurn`. The chat route
 * accumulates these from the runner's `ChatStreamEvent`s.
 */
export type ChatTurnNode =
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
  attachments?: ChatTurnAttachment[];
  startedAt: number;
  endedAt: number;
  ok: boolean;
  error?: string;
  /** The assistant's final reply text (the turn's terminal output). */
  finalText?: string;
  /** The turn's ordered trace (assistant steps + tool calls). */
  nodes: ChatTurnNode[];
}

/** Provides the gateway-side single user UUID. Wired to `UserStore.getUserId`. */
export type UserIdProvider = () => string;

/** Per-app lazily-opened conversation store — one entry per app touched. */
interface AppChat {
  store: ConversationStore;
}

export class ChatHistoryStore {
  private readonly appsDir: string;
  private readonly userIdProvider: UserIdProvider;
  private readonly analytics: RunSummarySink | undefined;
  /** Per-app blob CAS for attachment bytes — shares `appsDir` (issue #190). */
  private readonly blobs: BlobStore;
  private readonly perApp = new Map<string, AppChat>();

  /**
   * `analytics`, when set, threads into each app's `ConversationStore` so a
   * chat turn's `finishTurn` write-throughs a summary.
   */
  constructor(appsDir: string, userIdProvider: UserIdProvider, analytics?: RunSummarySink) {
    this.appsDir = appsDir;
    this.userIdProvider = userIdProvider;
    this.analytics = analytics;
    this.blobs = new BlobStore(appsDir);
  }

  private appChat(appId: string): AppChat {
    const cached = this.perApp.get(appId);
    if (cached) return cached;
    if (!isValidAppId(appId)) throw new Error(`chat-history: invalid app id "${appId}"`);
    const provider = makeRuntimeDbProvider(path.join(this.appsDir, appId, 'runtime.sqlite'));
    const entry: AppChat = { store: new ConversationStore(provider, this.analytics) };
    this.perApp.set(appId, entry);
    return entry;
  }

  private currentUserId(): string {
    return this.userIdProvider();
  }

  listSessions(appId: string): ChatSessionMeta[] {
    const { store } = this.appChat(appId);
    return store.listConversationsMeta(this.currentUserId()).map(toMeta);
  }

  /** Create a fresh chat session in `appId`. */
  createSession(appId: string, title: string = '', kind: RunKind = 'chat'): ChatSessionMeta {
    const { store } = this.appChat(appId);
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
  ): (ChatSessionMeta & { messages: ChatMessageRow[] }) | undefined {
    const { store } = this.appChat(appId);
    const meta = store.getConversationMeta(id, this.currentUserId());
    if (!meta) return undefined;

    const messages: ChatMessageRow[] = [];
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
    const { store } = this.appChat(appId);
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

  getSessionMeta(appId: string, id: string): ChatSessionMeta | undefined {
    const { store } = this.appChat(appId);
    const meta = store.getConversationMeta(id, this.currentUserId());
    return meta ? toMeta(meta) : undefined;
  }

  renameSession(appId: string, id: string, title: string): ChatSessionMeta | undefined {
    const { store } = this.appChat(appId);
    if (!store.renameConversation(id, this.currentUserId(), title)) return undefined;
    return this.getSessionMeta(appId, id);
  }

  deleteSession(appId: string, id: string): boolean {
    // Real FK CASCADE drops the conversation's turns, items, and attachment
    // rows; a follow-up blob GC reclaims now-unreferenced bytes (issue #190).
    const { store } = this.appChat(appId);
    const ok = store.deleteConversation(id, this.currentUserId());
    if (ok) void this.blobs.gc(appId, store.referencedHashes()).catch(() => undefined);
    return ok;
  }

  /**
   * Persist one completed chat turn: a `turns` row, its ordinal-0 `message_in`
   * item (plus any attachments), and the assistant/tool `items`, in `appId`'s
   * `runtime.sqlite`. Returns `undefined` when the conversation doesn't exist
   * or is owned by another user. The first turn names the conversation.
   */
  recordTurn(appId: string, input: RecordTurnInput): { turnId: string } | undefined {
    const { store } = this.appChat(appId);
    const userId = this.currentUserId();
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
  ): ChatSessionMeta | undefined {
    const { store } = this.appChat(appId);
    if (!store.noteTurn(sessionId, this.currentUserId(), adapter)) return undefined;
    return this.getSessionMeta(appId, sessionId);
  }
}

function recordNode(
  store: ConversationStore,
  turnId: string,
  ordinal: number,
  node: ChatTurnNode,
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

function toMeta(c: ConversationMeta): ChatSessionMeta {
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

// HTTP route dispatcher lives in chat-history-routes.ts to keep this file
// focused on the facade + fold. Re-exported below from the package index.
