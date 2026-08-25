// governance: allow-repo-hygiene file-size-limit (#420) the retry-collapsing transcript fold belongs beside the record/CRUD API it mirrors; the pure helpers already live in transcript.ts
/*
 * Conversation-history facade over the per-vault `ConversationStore`. A chat
 * session IS a `conversations` row, bound to its vault at creation — so a
 * mid-thread vault switch FAILS CLOSED (#280).
 *
 * The transcript is NOT its own table: the inbound message is the turn's
 * ordinal-0 `message_in` item, the rest of the trace is `items` (#190).
 */

import { randomUUID } from "node:crypto";

import { BlobStore, blobUrl } from "../data/blob-store.js";
import type { PutResult } from "../data/blob-store.js";
import { resolveItemCost } from "../model-pricing.js";
import { isValidAppOrAssistantId } from "../registry/app-paths.js";
import type { WorkspaceProvider } from "../stores/vault-workspace.js";
import { collectArchivedRows } from "./rehydrate.js";
import type { ArchiveBlobReader } from "./rehydrate.js";
import type {
  ConversationWorkspaceKind,
  ConversationWorkspaceSelection,
  Item,
  RunKind,
  Turn,
} from "./schema.js";
import { ConversationStore, MAX_TRANSCRIPT_TURNS } from "./store.js";
import type { ConversationMeta } from "./store.js";
import {
  groupRetryFamilies,
  parseStepOutput,
  parseToolArgs,
  parseToolOutput,
} from "./transcript.js";
import type { HarnessUsageSnapshot } from "./turn.js";

export { ASSISTANT_APP_ID } from "../registry/app-paths.js";

export interface ConversationSummary {
  id: string;
  userId: string;
  title: string;
  harnessKind: string | null;
  harnessSessionId: string | null;
  turnCount: number;
  hydrationCount: number;
  lastHydratedAt?: number;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface ConversationSearchResult extends ConversationSummary {
  snippet: string;
}

export interface ConversationMessageRow {
  idx: number;
  payload: unknown;
  createdAt: number;
}

/** `hasArchivedHistory` ⇒ some turns came from a pruned segment and are
 *  READ-ONLY; `archiveUnavailable` ⇒ the render is live rows only (#438). */
export interface SessionTranscript extends ConversationSummary {
  messages: ConversationMessageRow[];
  workspace?: ConversationWorkspaceSelection;
  hasArchivedHistory?: boolean;
  archivedTurnCount?: number;
  archiveUnavailable?: boolean;
  /** The client shows "load earlier" only when this is true (#659). */
  hasMore: boolean;
  /** A `beforeSeq` request returns ONLY that page, so the client can PREPEND:
   *  the projection keys on message identity, and rebuilding the array would
   *  re-key every already-rendered row. */
  oldestSeq?: number;
}

export interface TranscriptWindow {
  limit?: number;
  beforeSeq?: number;
}

/** `hash` is the CAS key; `url` is precomputed so a frontend renders a chip
 *  without deriving it. */
export interface ConversationAttachmentPayload {
  hash: string;
  mime: string;
  sizeBytes: number;
  filename?: string;
  source?: string;
  workspacePath?: string;
  url?: string;
}

export interface ConversationTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  model?: string;
  effort?: string;
}

export interface RecordedTurnReplay {
  turnId: string;
  ok: boolean;
  finalText?: string;
  error?: string;
  usage?: ConversationTurnUsage;
}

export interface ConversationTurnAttachment {
  hash: string;
  mime: string;
  sizeBytes: number;
  filename?: string;
  source?: string;
  workspacePath?: string;
}

export type TurnNode =
  | {
      kind: "step";
      text: string;
      isError?: boolean;
      notice?: { level: "info" | "warn"; code?: string };
      model?: string;
      harness?: string;
      effort?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      costUsd?: number;
      costSource?: "harness" | "estimated";
      startedAt: number;
      endedAt: number;
    }
  | {
      kind: "tool";
      toolName: string;
      sql?: string;
      args?: unknown;
      ok: boolean;
      result?: unknown;
      errorText?: string;
      artifacts?: ConversationTurnAttachment[];
      appId?: string;
      startedAt: number;
      endedAt: number;
    };

export interface RecordTurnInput {
  conversationId: string;
  /** Set on the CONVERSATION the first time it differs: a thread is
   *  single-kind (#190). */
  kind?: RunKind;
  userMessage: string;
  retryOf?: string;
  /** A duplicate POST with the same key REPLAYS this turn (#420). */
  idempotencyKey?: string;
  attachments?: ConversationTurnAttachment[];
  startedAt: number;
  endedAt: number;
  ok: boolean;
  error?: string;
  finalText?: string;
  hydrationTokens?: number;
  nodes: TurnNode[];
  harnessObservation?: {
    kind: string;
    sessionId?: string;
    usageSnapshot?: HarnessUsageSnapshot;
    hydrated?: boolean;
  };
  failedHarnessObservation?: {
    kind: string;
    sessionId?: string;
    usageSnapshot?: HarnessUsageSnapshot;
    hydrated?: boolean;
  };
}

export class ConversationHistoryStore {
  private readonly workspace: WorkspaceProvider;
  /** ONE store over the ACTIVE vault's journal.db: the provider resolves per
   *  call, so a vault switch needs no reconstruction here. */
  private readonly store: ConversationStore;
  private readonly blobs: BlobStore;
  /** app-engine must not import vault, so the reader crosses THIS seam;
   *  undefined degrades rehydration to `archiveUnavailable` (#438). */
  private readonly archiveBlobReader: ArchiveBlobReader | undefined;

  constructor(
    workspace: WorkspaceProvider,
    options: { archiveBlobReader?: ArchiveBlobReader } = {}
  ) {
    this.workspace = workspace;
    this.store = new ConversationStore(() => workspace().journal());
    this.blobs = new BlobStore(() => workspace().appsDir);
    this.archiveBlobReader = options.archiveBlobReader;
  }

  private appConversation(appId: string): { store: ConversationStore } {
    if (!isValidAppOrAssistantId(appId)) {
      throw new Error(`conversation-history: invalid app id "${appId}"`);
    }
    return { store: this.store };
  }

  private currentUserId(): string {
    return this.workspace().ownerPartyId;
  }

  /** The ledger file is per-VAULT, so per-app isolation is enforced HERE: a
   *  cross-app id lookup reads as not-found (#280). */
  private ownedMeta(appId: string, id: string): ConversationMeta | undefined {
    const meta = this.store.getConversationMeta(id, this.currentUserId());
    if (!meta || meta.appId !== appId) return undefined;
    return meta;
  }

  listSessions(appId: string): ConversationSummary[] {
    const { store } = this.appConversation(appId);
    return store.listConversationsMeta(this.currentUserId(), appId).map(toMeta);
  }

  createSession(
    appId: string,
    title: string = "",
    kind: RunKind = "chat"
  ): ConversationSummary {
    const { store } = this.appConversation(appId);
    const conv = store.createConversation({
      kind,
      userId: this.currentUserId(),
      appId,
      title,
    });
    return toMeta({ ...conv, messageCount: 0 });
  }

  /** LIVE rows only — the archive-aware path is `getSessionRehydrated`. */
  getSession(
    appId: string,
    id: string,
    window: TranscriptWindow = {}
  ): SessionTranscript | undefined {
    const { store } = this.appConversation(appId);
    const meta = this.ownedMeta(appId, id);
    if (!meta) return undefined;

    const page = store.listTurnWindow(id, window);
    const turns = page.turns;
    // Scope the batched reads to the SAME seq range, so a window costs a
    // window's rows.
    const range = seqRangeOf(turns);
    const itemsByTurn = store.listItemsByTurn(id, range);
    const attachmentsByItem = store.listAttachmentsByItem(id, range);

    const messages = foldTranscript({
      turns,
      itemsByTurn,
      attachmentsOf: (itemId) =>
        attachmentPayloads(appId, attachmentsByItem.get(itemId)),
      isArchived: () => false,
    });
    const workspace = store.getWorkspaceSelection(id);
    return {
      ...toMeta(meta),
      messageCount: messages.length,
      messages,
      ...(workspace ? { workspace } : {}),
      hasMore: page.hasMore,
      ...(page.oldestSeq === undefined ? {} : { oldestSeq: page.oldestSeq }),
    };
  }

  /** Merges PRUNED archive ranges back in, marked `fromArchive` (#438).
   *  READ-ONLY: the raw rows are gone, so mutation paths no-op. A fetch failure
   *  yields `archiveUnavailable`, never a silently partial thread. */
  async getSessionRehydrated(
    appId: string,
    id: string,
    window: TranscriptWindow = {}
  ): Promise<SessionTranscript | undefined> {
    const { store } = this.appConversation(appId);
    const meta = this.ownedMeta(appId, id);
    if (!meta) return undefined;

    const prunedRefs = store.listArchiveSegments(id).filter((r) => r.pruned);
    // No pruned range ⇒ every turn is still a live row.
    if (prunedRefs.length === 0) return this.getSession(appId, id, window);

    const archived = await collectArchivedRows(
      this.archiveBlobReader,
      prunedRefs
    );

    const liveTurns = store.listTurns(id);
    const itemsByTurn = store.listItemsByTurn(id);
    const attachmentsByItem = store.listAttachmentsByItem(id);
    for (const [turnId, items] of archived.itemsByTurn)
      itemsByTurn.set(turnId, items);

    const merged = [...archived.turns, ...liveTurns].sort(
      (a, b) => a.seq - b.seq
    );
    // Windowing happens AFTER the merge, in memory (#659 G5): pushing it into
    // SQL would window only the live half and report `hasMore` against a
    // partial picture.
    const { turns, hasMore } = windowMerged(merged, window);

    const messages = foldTranscript({
      turns,
      itemsByTurn,
      attachmentsOf: (itemId) =>
        attachmentPayloads(
          appId,
          archived.attachmentsByItem.get(itemId) ??
            attachmentsByItem.get(itemId)
        ),
      isArchived: (turnId) => archived.turnIds.has(turnId),
    });

    return {
      ...toMeta(meta),
      messageCount: messages.length,
      messages,
      ...(store.getWorkspaceSelection(id)
        ? { workspace: store.getWorkspaceSelection(id)! }
        : {}),
      hasArchivedHistory: true,
      archivedTurnCount: archived.turnIds.size,
      ...(archived.unavailable ? { archiveUnavailable: true } : {}),
      hasMore,
      ...(turns.length > 0 ? { oldestSeq: turns[0]!.seq } : {}),
    };
  }

  private attachmentsPayload(
    appId: string,
    itemId: string
  ): ConversationAttachmentPayload[] {
    const { store } = this.appConversation(appId);
    return attachmentPayloads(appId, store.listAttachmentsForItem(itemId));
  }

  uploadBlob(appId: string, bytes: Uint8Array): Promise<PutResult> {
    return this.blobs.put(appId, bytes);
  }

  readBlob(appId: string, hash: string): Promise<Buffer | undefined> {
    return this.blobs.read(appId, hash);
  }

  blobPathFor(appId: string, hash: string): string {
    return this.blobs.pathFor(appId, hash);
  }

  getSessionMeta(appId: string, id: string): ConversationSummary | undefined {
    const meta = this.ownedMeta(appId, id);
    return meta ? toMeta(meta) : undefined;
  }

  renameSession(
    appId: string,
    id: string,
    title: string
  ): ConversationSummary | undefined {
    const { store } = this.appConversation(appId);
    if (!this.ownedMeta(appId, id)) return undefined;
    if (!store.renameConversation(id, this.currentUserId(), title))
      return undefined;
    return this.getSessionMeta(appId, id);
  }

  searchSessions(
    appId: string,
    query: string,
    limit = 20
  ): ConversationSearchResult[] {
    const { store } = this.appConversation(appId);
    return store
      .searchConversations(this.currentUserId(), query, appId, limit)
      .map((hit) => ({ ...toMeta(hit), snippet: hit.snippet }));
  }

  setSessionPinned(
    appId: string,
    id: string,
    pinned: boolean
  ): ConversationSummary | undefined {
    const { store } = this.appConversation(appId);
    if (!this.ownedMeta(appId, id)) return undefined;
    if (!store.setConversationPinned(id, this.currentUserId(), pinned))
      return undefined;
    return this.getSessionMeta(appId, id);
  }

  setSessionArchived(
    appId: string,
    id: string,
    archived: boolean
  ): ConversationSummary | undefined {
    const { store } = this.appConversation(appId);
    if (!this.ownedMeta(appId, id)) return undefined;
    if (!store.setConversationArchived(id, this.currentUserId(), archived))
      return undefined;
    return this.getSessionMeta(appId, id);
  }

  /** False when unowned, and also when the turn was PRUNED (#438): its row is
   *  gone, so mutating sealed history is impossible. */
  setTurnFeedback(
    appId: string,
    id: string,
    turnId: string,
    feedback: "up" | "down" | null
  ): boolean {
    const { store } = this.appConversation(appId);
    if (!this.ownedMeta(appId, id)) return false;
    return store.setTurnFeedback(id, turnId, feedback);
  }

  deleteSession(appId: string, id: string): boolean {
    // FK CASCADE drops turns, items and attachment rows; a follow-up blob GC
    // reclaims the now-unreferenced bytes.
    const { store } = this.appConversation(appId);
    if (!this.ownedMeta(appId, id)) return false;
    const ok = store.deleteConversation(id, this.currentUserId());
    if (ok)
      void this.blobs
        .gc(appId, store.referencedHashes())
        .catch(() => undefined);
    return ok;
  }

  /** `undefined` when the conversation is absent from the ACTIVE vault, which
   *  is how a mid-turn vault switch fails closed (#280). */
  recordTurn(
    appId: string,
    input: RecordTurnInput
  ): { turnId: string } | undefined {
    const { store } = this.appConversation(appId);
    const userId = this.currentUserId();
    if (!this.ownedMeta(appId, input.conversationId)) return undefined;
    const existingTitle = store.titleOf(input.conversationId, userId);
    if (existingTitle === undefined) return undefined;

    const turnId = randomUUID();
    store.runInTransaction(() => {
      if (input.kind && input.kind !== "chat") {
        store.setKind(input.conversationId, userId, input.kind);
      }
      store.insertTurn({
        turnId,
        conversationId: input.conversationId,
        triggerKind: "interactive",
        startedAt: input.startedAt,
        ...(input.hydrationTokens === undefined
          ? {}
          : { hydrationTokens: input.hydrationTokens }),
        ...(input.retryOf === undefined ? {} : { retryOf: input.retryOf }),
        ...(input.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: input.idempotencyKey }),
      });
      const messageItemId = store.insertMessageIn({
        turnId,
        role: "user",
        text: input.userMessage,
        startedAt: input.startedAt,
      });
      for (const att of input.attachments ?? []) {
        store.insertAttachment({
          itemId: messageItemId,
          hash: att.hash,
          mime: att.mime,
          sizeBytes: att.sizeBytes,
          source: att.source ?? "upload",
          ...(att.filename === undefined ? {} : { filename: att.filename }),
          ...(att.workspacePath === undefined
            ? {}
            : { workspacePath: att.workspacePath }),
        });
      }
      // Ordinal 0 is the inbound message.
      input.nodes.forEach((node, i) => {
        const itemId = recordNode(store, turnId, i + 1, node);
        if (node.kind !== "tool") return;
        for (const artifact of node.artifacts ?? []) {
          store.insertAttachment({
            itemId,
            hash: artifact.hash,
            mime: artifact.mime,
            sizeBytes: artifact.sizeBytes,
            source: artifact.source ?? "harness",
            ...(artifact.filename === undefined
              ? {}
              : { filename: artifact.filename }),
            ...(artifact.workspacePath === undefined
              ? {}
              : { workspacePath: artifact.workspacePath }),
          });
        }
      });
      store.finishTurn({
        turnId,
        endedAt: input.endedAt,
        ok: input.ok,
        ...(input.error === undefined ? {} : { error: input.error }),
        ...(input.finalText === undefined
          ? {}
          : { outputJson: JSON.stringify({ text: input.finalText }) }),
      });
      if (input.failedHarnessObservation) {
        store.noteFailedTurn(
          input.conversationId,
          userId,
          input.failedHarnessObservation
        );
      } else {
        store.noteTurn(input.conversationId, userId, input.harnessObservation);
      }
      const now = Date.now();
      if (existingTitle) {
        store.touchConversation(input.conversationId, userId, now);
      } else {
        store.setTitle(
          input.conversationId,
          userId,
          deriveTitle(input.userMessage),
          now
        );
      }
    });
    return { turnId };
  }

  findRecordedTurn(
    appId: string,
    conversationId: string,
    idempotencyKey: string
  ): RecordedTurnReplay | undefined {
    const { store } = this.appConversation(appId);
    if (!this.ownedMeta(appId, conversationId)) return undefined;
    const turn = store.getTurnByIdempotencyKey(conversationId, idempotencyKey);
    if (!turn) return undefined;
    const parsed = parseStepOutput(turn.outputJson);
    const step = store
      .listItems(turn.turnId)
      .findLast((it) => it.kind === "step");
    const usage: ConversationTurnUsage = {
      ...(turn.totalInputTokens === undefined
        ? {}
        : { inputTokens: turn.totalInputTokens }),
      ...(turn.totalOutputTokens === undefined
        ? {}
        : { outputTokens: turn.totalOutputTokens }),
      ...(turn.totalCostUsd === undefined
        ? {}
        : { costUsd: turn.totalCostUsd }),
      ...(step?.model ? { model: step.model } : {}),
      ...(step?.effort ? { effort: step.effort } : {}),
    };
    return {
      turnId: turn.turnId,
      ok: turn.ok,
      ...(parsed.text ? { finalText: parsed.text } : {}),
      ...(turn.error === undefined ? {} : { error: turn.error }),
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
    };
  }

  noteTurn(
    appId: string,
    sessionId: string,
    harnessObservation?: {
      kind: string;
      sessionId?: string;
      usageSnapshot?: HarnessUsageSnapshot;
      hydrated?: boolean;
    }
  ): ConversationSummary | undefined {
    const { store } = this.appConversation(appId);
    if (!this.ownedMeta(appId, sessionId)) return undefined;
    if (!store.noteTurn(sessionId, this.currentUserId(), harnessObservation))
      return undefined;
    return this.getSessionMeta(appId, sessionId);
  }

  /** Never crosses the client wire. */
  getHarnessResumeState(
    appId: string,
    sessionId: string,
    harnessKind?: string
  ):
    | {
        bindingId?: string;
        kind?: string;
        sessionId?: string;
        usageSnapshot?: HarnessUsageSnapshot;
        hydratedThroughSeq?: number;
      }
    | undefined {
    const meta = this.ownedMeta(appId, sessionId);
    if (!meta) return undefined;
    const { store } = this.appConversation(appId);
    const kind = harnessKind ?? meta.harnessKind ?? undefined;
    const binding = kind ? store.getHarnessBinding(sessionId, kind) : undefined;
    if (binding) {
      return {
        bindingId: binding.id,
        kind: binding.kind,
        sessionId: binding.acpSessionId,
        ...(binding.usageSnapshot
          ? { usageSnapshot: binding.usageSnapshot }
          : {}),
        hydratedThroughSeq: binding.hydratedThroughSeq,
      };
    }
    // Falling back to a different active harness would pair the wrong opaque
    // session id with the requested one. A miss is `undefined`, never `{}` —
    // call sites truthiness-test the result.
    if (harnessKind) return undefined;
    return {
      ...(meta.harnessKind ? { kind: meta.harnessKind } : {}),
      ...(meta.harnessSessionId ? { sessionId: meta.harnessSessionId } : {}),
      ...(meta.harnessUsageSnapshot
        ? { usageSnapshot: meta.harnessUsageSnapshot }
        : {}),
    };
  }

  markAdapterBindingStale(
    appId: string,
    conversationId: string,
    bindingId: string
  ): void {
    const { store } = this.appConversation(appId);
    if (!this.ownedMeta(appId, conversationId)) return;
    store.markHarnessBindingStale(bindingId);
  }

  /** Custody-safe: pruned rows never enter this path, only turns still in the
   *  ledger after the binding's watermark. */
  getHydrationDelta(
    appId: string,
    conversationId: string,
    afterSeq: number
  ): { messages: ConversationMessageRow[]; throughSeq: number } | undefined {
    const { store } = this.appConversation(appId);
    if (!this.ownedMeta(appId, conversationId)) return undefined;
    const all = store.listTurns(conversationId);
    // `seq` starts at 0, so the empty-ledger watermark is -1.
    const throughSeq = all.at(-1)?.seq ?? -1;
    const turns = all.filter((turn) => turn.seq > afterSeq);
    const itemsByTurn = new Map<string, Item[]>();
    for (const turn of turns)
      itemsByTurn.set(turn.turnId, store.listItems(turn.turnId));
    return {
      messages: foldTranscript({
        turns,
        itemsByTurn,
        attachmentsOf: (itemId) => this.attachmentsPayload(appId, itemId),
        isArchived: () => false,
      }),
      throughSeq,
    };
  }

  acquireTurnLock(
    appId: string,
    conversationId: string,
    token: string
  ): boolean {
    const { store } = this.appConversation(appId);
    return (
      this.ownedMeta(appId, conversationId) !== undefined &&
      store.acquireTurnLock(conversationId, token)
    );
  }

  refreshTurnLock(
    appId: string,
    conversationId: string,
    token: string
  ): boolean {
    const { store } = this.appConversation(appId);
    return (
      this.ownedMeta(appId, conversationId) !== undefined &&
      store.refreshTurnLock(conversationId, token)
    );
  }

  releaseTurnLock(appId: string, conversationId: string, token: string): void {
    const { store } = this.appConversation(appId);
    store.releaseTurnLock(conversationId, token);
  }

  getWorkspaceSelection(
    appId: string,
    conversationId: string
  ): ConversationWorkspaceSelection | undefined {
    const { store } = this.appConversation(appId);
    if (!this.ownedMeta(appId, conversationId)) return undefined;
    return store.getWorkspaceSelection(conversationId);
  }

  setWorkspaceSelection(
    appId: string,
    conversationId: string,
    primaryKind: ConversationWorkspaceKind,
    additionalDirectories: readonly string[]
  ): void {
    const { store } = this.appConversation(appId);
    if (!this.ownedMeta(appId, conversationId))
      throw new Error("No such conversation.");
    store.setWorkspaceSelection(
      conversationId,
      primaryKind,
      additionalDirectories
    );
  }
}

interface TranscriptSources {
  turns: Turn[];
  itemsByTurn: Map<string, Item[]>;
  attachmentsOf: (itemId: string) => ConversationAttachmentPayload[];
  isArchived: (turnId: string) => boolean;
}

/** PURE — no store access — so the live and archive-merged paths share ONE
 *  fold, collapsing retry families into a sibling pager (#420). */
function foldTranscript(src: TranscriptSources): ConversationMessageRow[] {
  const { turns, itemsByTurn, attachmentsOf, isArchived } = src;
  const messages: ConversationMessageRow[] = [];
  let idx = 0;

  // The one attempt text the retry pager flips between (#420).
  const answerOf = (turnId: string): { text: string; error: boolean } => {
    const last = (itemsByTurn.get(turnId) ?? []).findLast(
      (it) => it.kind === "step"
    );
    return parseStepOutput(last?.outputJson);
  };

  // The frozen denormalized rollup on the turn; the serving model comes off
  // the terminal step.
  const usageOf = (turn: Turn): ConversationTurnUsage | undefined => {
    const step = (itemsByTurn.get(turn.turnId) ?? []).findLast(
      (it) => it.kind === "step"
    );
    const usage: ConversationTurnUsage = {
      ...(turn.totalInputTokens === undefined
        ? {}
        : { inputTokens: turn.totalInputTokens }),
      ...(turn.totalOutputTokens === undefined
        ? {}
        : { outputTokens: turn.totalOutputTokens }),
      ...(turn.totalCostUsd === undefined
        ? {}
        : { costUsd: turn.totalCostUsd }),
      ...(step?.model ? { model: step.model } : {}),
      ...(step?.effort ? { effort: step.effort } : {}),
    };
    return Object.keys(usage).length > 0 ? usage : undefined;
  };

  // One row per FAMILY: latest attempt inline, siblings for the pager.
  for (const family of groupRetryFamilies(turns)) {
    const root = family[0] as Turn;
    const active = family.at(-1) as Turn;
    // A family archives as one contiguous range, so the root's state stands.
    const arch = isArchived(root.turnId);
    const activeItems = itemsByTurn.get(active.turnId) ?? [];
    const terminalStepId = activeItems.findLast(
      (it) => it.kind === "step"
    )?.itemId;
    const retry =
      family.length > 1
        ? {
            index: family.length,
            count: family.length,
            attempts: family.map((t) => {
              const ans = answerOf(t.turnId);
              const usage = usageOf(t);
              return {
                turnId: t.turnId,
                text: ans.text,
                ...(ans.error ? { error: true } : {}),
                feedback: t.feedback ?? null,
                ...(usage ? { usage } : {}),
              };
            }),
          }
        : undefined;

    // Once, from the root attempt: every retry re-sends the same prompt.
    const userItem = (itemsByTurn.get(root.turnId) ?? []).find(
      (it) => it.kind === "message_in"
    );
    if (userItem) {
      const attachments = attachmentsOf(userItem.itemId);
      messages.push({
        idx: idx++,
        payload: {
          kind: "user",
          text: userItem.text ?? "",
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(arch ? { fromArchive: true } : {}),
        },
        createdAt: userItem.startedAt,
      });
    }

    for (const item of activeItems) {
      if (item.kind === "step") {
        const parsed = parseStepOutput(item.outputJson);
        if (item.name?.startsWith("notice:")) {
          const [, level] = item.name.split(":");
          messages.push({
            idx: idx++,
            payload: {
              kind: "notice",
              level: level === "warn" ? "warn" : "info",
              text: parsed.text,
              ...(arch ? { fromArchive: true } : {}),
            },
            createdAt: item.startedAt,
          });
          continue;
        }
        // Only the terminal step carries identity, feedback and the pager.
        const terminal = item.itemId === terminalStepId;
        messages.push({
          idx: idx++,
          payload: {
            kind: "ai",
            text: parsed.text,
            ...(parsed.error ? { error: true } : {}),
            ...(arch ? { fromArchive: true } : {}),
            ...(terminal
              ? {
                  turnId: active.turnId,
                  feedback: active.feedback ?? null,
                  ...(retry ? { retry } : {}),
                  ...(usageOf(active) ? { usage: usageOf(active) } : {}),
                }
              : {}),
          },
          createdAt: item.startedAt,
        });
      } else if (item.kind === "tool") {
        const args = parseToolArgs(item.argsJson);
        const out = parseToolOutput(item.outputJson);
        const artifacts = attachmentsOf(item.itemId);
        messages.push({
          idx: idx++,
          payload: {
            kind: "tool",
            id: item.itemId,
            tool: item.name ?? "tool",
            ...(args.sql === undefined ? {} : { sql: args.sql }),
            ...(args.args === undefined ? {} : { args: args.args }),
            state: item.ok ? "ok" : "error",
            ...(out.result === undefined ? {} : { result: out.result }),
            ...(out.errorText === undefined
              ? {}
              : { errorText: out.errorText }),
            ...(artifacts.length > 0 ? { artifacts } : {}),
            ...(arch ? { fromArchive: true } : {}),
          },
          createdAt: item.startedAt,
        });
      }
    }
  }
  return messages;
}

function recordNode(
  store: ConversationStore,
  turnId: string,
  ordinal: number,
  node: TurnNode
): string {
  const itemId = randomUUID();
  if (node.kind === "step") {
    // Prefer harness/ACP cost; else catalog estimate; else NULL (#514).
    const usage = {
      ...(node.inputTokens === undefined
        ? {}
        : { inputTokens: node.inputTokens }),
      ...(node.outputTokens === undefined
        ? {}
        : { outputTokens: node.outputTokens }),
      ...(node.cacheReadTokens === undefined
        ? {}
        : { cacheReadTokens: node.cacheReadTokens }),
      ...(node.cacheWriteTokens === undefined
        ? {}
        : { cacheWriteTokens: node.cacheWriteTokens }),
    };
    const resolved =
      node.costSource === "harness" && node.costUsd !== undefined
        ? { costUsd: node.costUsd, costSource: "harness" as const }
        : node.costSource === "estimated" && node.costUsd !== undefined
          ? { costUsd: node.costUsd, costSource: "estimated" as const }
          : resolveItemCost({
              ...(node.costUsd === undefined
                ? {}
                : { harnessCostUsd: node.costUsd }),
              model: node.model,
              usage,
            });
    store.insertItem({
      itemId,
      turnId,
      ordinal,
      kind: "step",
      ...(node.notice
        ? {
            name: `notice:${node.notice.level}:${node.notice.code ?? "harness"}`,
          }
        : {}),
      outputJson: JSON.stringify({
        text: node.text,
        ...(node.isError ? { error: true } : {}),
      }),
      ok: !node.isError,
      ...(node.model === undefined ? {} : { model: node.model }),
      ...(node.harness === undefined ? {} : { harness: node.harness }),
      ...(node.effort === undefined ? {} : { effort: node.effort }),
      ...(node.inputTokens === undefined
        ? {}
        : { inputTokens: node.inputTokens }),
      ...(node.outputTokens === undefined
        ? {}
        : { outputTokens: node.outputTokens }),
      ...(node.cacheReadTokens === undefined
        ? {}
        : { cacheReadTokens: node.cacheReadTokens }),
      ...(node.cacheWriteTokens === undefined
        ? {}
        : { cacheWriteTokens: node.cacheWriteTokens }),
      ...(resolved.costUsd === undefined ? {} : { costUsd: resolved.costUsd }),
      ...(resolved.costSource === undefined
        ? {}
        : { costSource: resolved.costSource }),
      startedAt: node.startedAt,
      endedAt: node.endedAt,
      durationMs: Math.max(0, node.endedAt - node.startedAt),
    });
  } else {
    store.insertItem({
      itemId,
      turnId,
      ordinal,
      kind: "tool",
      name: node.toolName,
      argsJson: JSON.stringify({
        ...(node.sql === undefined ? {} : { sql: node.sql }),
        ...(node.args === undefined ? {} : { args: node.args }),
      }),
      outputJson: JSON.stringify({
        ...(node.result === undefined ? {} : { result: node.result }),
        ...(node.errorText === undefined ? {} : { errorText: node.errorText }),
      }),
      ok: node.ok,
      ...(node.errorText === undefined ? {} : { error: node.errorText }),
      ...(node.appId === undefined ? {} : { appId: node.appId }),
      startedAt: node.startedAt,
      endedAt: node.endedAt,
      durationMs: Math.max(0, node.endedAt - node.startedAt),
    });
  }
  return itemId;
}

function seqRangeOf(turns: readonly Turn[]): {
  fromSeq?: number;
  toSeq?: number;
} {
  if (turns.length === 0) return {};
  return { fromSeq: turns[0]!.seq, toSeq: turns.at(-1)!.seq };
}

function windowMerged(
  merged: readonly Turn[],
  window: TranscriptWindow
): { turns: Turn[]; hasMore: boolean } {
  const eligible =
    window.beforeSeq === undefined
      ? merged
      : merged.filter((turn) => turn.seq < window.beforeSeq!);
  const limit = Math.max(
    1,
    Math.min(window.limit ?? MAX_TRANSCRIPT_TURNS, MAX_TRANSCRIPT_TURNS)
  );
  if (eligible.length <= limit) {
    return { turns: [...eligible], hasMore: false };
  }
  return { turns: eligible.slice(eligible.length - limit), hasMore: true };
}

/** ONE mapper for live rows and rehydrated archive rows, so the two cannot
 *  drift (#659). */
function attachmentPayloads(
  appId: string,
  attachments:
    | readonly {
        hash: string;
        mime: string;
        sizeBytes: number;
        filename?: string;
        source?: string;
        workspacePath?: string;
      }[]
    | undefined
): ConversationAttachmentPayload[] {
  if (!attachments || attachments.length === 0) return [];
  return attachments.map((a) => ({
    hash: a.hash,
    mime: a.mime,
    sizeBytes: a.sizeBytes,
    ...(a.filename === undefined ? {} : { filename: a.filename }),
    ...(a.source !== undefined && a.source !== "upload"
      ? { source: a.source }
      : {}),
    ...(a.workspacePath === undefined
      ? { url: blobUrl(appId, a.hash) }
      : { workspacePath: a.workspacePath }),
  }));
}

function toMeta(c: ConversationMeta): ConversationSummary {
  return {
    id: c.id,
    userId: c.userId,
    title: c.title,
    harnessKind: c.harnessKind ?? null,
    harnessSessionId: c.harnessSessionId ?? null,
    turnCount: c.turnCount,
    hydrationCount: c.hydrationCount,
    ...(c.lastHydratedAt === undefined
      ? {}
      : { lastHydratedAt: c.lastHydratedAt }),
    pinned: c.pinned,
    archived: c.archived,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    messageCount: c.messageCount,
  };
}

export function deriveTitle(text: string): string {
  const cleaned = text.replace(/\s+/gu, " ").trim();
  if (cleaned.length === 0) return "";
  if (cleaned.length <= 60) return cleaned;
  return `${cleaned.slice(0, 57)}…`;
}
