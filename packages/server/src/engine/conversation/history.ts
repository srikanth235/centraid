// governance: allow-repo-hygiene file-size-limit (#420) cohesive conversation-history facade; the retry-collapsing transcript fold (getSession) belongs beside the record/CRUD API it mirrors — the pure helpers already live in transcript.ts
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
 * `journal.db` — a conversation binds to its vault at creation, so
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
  /** Owner of the session — the gateway-side user UUID from `UserStore`. */
  userId: string;
  title: string;
  /** Harness kind that owns `harnessSessionId` (codex | claude-code). */
  harnessKind: string | null;
  /** Opaque per-harness resume handle; `null` until the first turn lands. */
  harnessSessionId: string | null;
  /** Number of completed turns on this session. */
  turnCount: number;
  /** Number of canonical-ledger hydrations across harness/session handoffs. */
  hydrationCount: number;
  /** Most recent hydration boundary. */
  lastHydratedAt?: number;
  /** Pinned threads sort first in the sidebar (issue #420). */
  pinned: boolean;
  /** Archived threads hide behind a collapsed group and drop out of search. */
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  /** Reconstructed transcript length (user + assistant + tool messages). */
  messageCount: number;
}

/** A conversation search hit: its summary plus a highlighted match snippet. */
export interface ConversationSearchResult extends ConversationSummary {
  /** `snippet()` output with `⟦`/`⟧` around matched terms and `…` elisions. */
  snippet: string;
}

export interface ConversationMessageRow {
  idx: number;
  payload: unknown;
  createdAt: number;
}

/**
 * A loaded session: its summary, the reconstructed transcript, and — for the
 * archive-aware read (issue #438 wave 3) — markers describing rehydrated cold
 * history. `hasArchivedHistory` is set when some turns were fetched back from a
 * pruned segment (they carry `fromArchive: true` in their payload and are
 * read-only); `archiveUnavailable` when a pruned segment blob couldn't be
 * fetched, so the render is the live rows only.
 */
export interface SessionTranscript extends ConversationSummary {
  messages: ConversationMessageRow[];
  workspace?: ConversationWorkspaceSelection;
  hasArchivedHistory?: boolean;
  archivedTurnCount?: number;
  archiveUnavailable?: boolean;
  /**
   * Older turns exist before this response's oldest one (issue #659 G5) — the
   * client shows its "load earlier" control only when this is true.
   */
  hasMore: boolean;
  /**
   * `seq` of the oldest turn in this response: the cursor to pass back as
   * `beforeSeq` for the previous page. Absent for an empty transcript.
   *
   * A `beforeSeq` request returns ONLY that page's messages, never the page
   * plus what the caller already has, so the client can PREPEND them to its
   * existing array. That matters because the transcript projection keys on
   * message object identity, so rebuilding the array would re-key every
   * already-rendered row; prepending keeps them referentially identical.
   */
  oldestSeq?: number;
}

/** A page request for {@link SessionTranscript} — see `listTurnWindow`. */
export interface TranscriptWindow {
  /** Turns to return, newest-first by selection. Defaults to the whole thread. */
  limit?: number;
  /** Return only turns strictly older than this `seq`. */
  beforeSeq?: number;
}

/**
 * Attachment metadata exposed on a reconstructed `user` transcript entry
 * (issue: model/attachment prefs plumbing). One entry per `attachments`
 * row FK'd to the turn's `message_in` item — `hash` is the CAS key (see
 * `blobUrl`/`blobPathFor`), `url` a ready-to-fetch download link so both
 * frontends can render an attachment chip without recomputing it.
 */
export interface ConversationAttachmentPayload {
  hash: string;
  mime: string;
  sizeBytes: number;
  filename?: string;
  source?: string;
  /** Workspace-backed harness artifact; no CAS URL is emitted. */
  workspacePath?: string;
  url?: string;
}

/**
 * Per-turn token/cost usage on a reconstructed terminal `ai` transcript entry
 * (issue #420, Wave 2). Token sums + `costUsd` are the frozen denormalized
 * rollup on the turn (`model-pricing.ts` cost, frozen at write); `model` is the
 * serving model off the terminal step. Every field is optional — a legacy or
 * unpriced turn simply omits what it doesn't have.
 */
export interface ConversationTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  model?: string;
  effort?: string;
}

/**
 * The replayable result of an already-recorded turn, keyed by idempotency key
 * (issue #420). A duplicate turn POST streams this straight from the ledger.
 */
export interface RecordedTurnReplay {
  turnId: string;
  ok: boolean;
  /** The recorded final answer text (absent when the turn errored). */
  finalText?: string;
  /** The recorded error message (present when `ok` is false). */
  error?: string;
  usage?: ConversationTurnUsage;
}

/** A file already landed in the blob CAS, to attach to a turn's inbound message. */
export interface ConversationTurnAttachment {
  hash: string;
  mime: string;
  sizeBytes: number;
  filename?: string;
  /** Defaults to `'upload'`. */
  source?: string;
  /** Absolute harness workspace path; when set the bytes are not copied to CAS. */
  workspacePath?: string;
}

/**
 * One item of a completed chat turn, handed to `recordTurn`. The chat route
 * accumulates these from the harness's `TurnStreamEvent`s.
 */
export type TurnNode =
  | {
      kind: "step";
      /** Accumulated assistant text for the turn. */
      text: string;
      /** True when this step carries a harness/turn error message. */
      isError?: boolean;
      /** Durable harness/failover/self-heal notice rather than model prose. */
      notice?: { level: "info" | "warn"; code?: string };
      model?: string;
      harness?: string;
      effort?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      /** Harness/ACP-reported USD when present (issue #514). */
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
  /**
   * The conversation kind. A builder-surface turn is `'build'`; a data chat is
   * `'chat'` (the default). Set on the conversation the first time it differs
   * — a thread is single-kind (issue #190).
   */
  kind?: RunKind;
  /** The user's prompt for the turn — recorded as the `message_in` item. */
  userMessage: string;
  /**
   * When set, this turn is a regenerate of the turn with this id — recorded
   * as `turns.retry_of` so `getSession` collapses it into the original's
   * sibling pager (ChatGPT-style "<2/2>", issue #420).
   */
  retryOf?: string;
  /**
   * Client-supplied idempotency key (issue #420). Persisted on the turn so a
   * duplicate POST with the same key replays this recorded turn.
   */
  idempotencyKey?: string;
  /** Files that rode in on this turn's inbound message (already in the CAS). */
  attachments?: ConversationTurnAttachment[];
  startedAt: number;
  endedAt: number;
  ok: boolean;
  error?: string;
  /** The assistant's final reply text (the turn's terminal output). */
  finalText?: string;
  /** Estimated canonical-ledger prompt tokens injected for this handoff. */
  hydrationTokens?: number;
  /** The turn's ordered trace (assistant steps + tool calls). */
  nodes: TurnNode[];
  /** Successful harness binding committed atomically with this turn + watermark. */
  harnessObservation?: {
    kind: string;
    sessionId?: string;
    usageSnapshot?: HarnessUsageSnapshot;
    hydrated?: boolean;
  };
  /** Failed-turn accounting update that must not switch the active binding. */
  failedHarnessObservation?: {
    kind: string;
    sessionId?: string;
    usageSnapshot?: HarnessUsageSnapshot;
    hydrated?: boolean;
  };
}

// Re-exported for back-compat — every existing import site pulls this from
// the package root (`@centraid/server/engine`), which re-exports it from here.
// The value now lives in `app-paths.ts` (see there for why).

export class ConversationHistoryStore {
  private readonly workspace: WorkspaceProvider;
  /**
   * ONE ledger store over "the ACTIVE vault's journal.db" — the provider
   * resolves the workspace per call and the store re-prepares on handle
   * change, so a vault switch needs no reconstruction here.
   */
  private readonly store: ConversationStore;
  /** Blob CAS for attachment bytes — rooted at the active workspace (#190/#280). */
  private readonly blobs: BlobStore;
  /**
   * Read-back of an archived segment blob from the vault CAS (issue #438 wave 3).
   * Injected by the gateway (`db.blobs.open`); undefined on the standalone host,
   * where rehydration degrades to an `archiveUnavailable` marker. app-engine must
   * not import vault, so the reader crosses this seam, not `VaultWorkspace`.
   */
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

  /**
   * Load a session with its transcript reconstructed uniformly from the
   * conversation's items: each turn contributes its ordinal-0 `message_in`
   * item as a `user` message (with any attachments), then `step` items as
   * `ai` messages and `tool` items as `tool` messages (issue #190). Live rows
   * only — the archive-aware read path is `getSessionRehydrated`.
   */
  getSession(
    appId: string,
    id: string,
    window: TranscriptWindow = {}
  ): SessionTranscript | undefined {
    const { store } = this.appConversation(appId);
    const meta = this.ownedMeta(appId, id);
    if (!meta) return undefined;

    // Three queries for the page (issue #659 G5): turns, then its items, then
    // its attachments.
    const page = store.listTurnWindow(id, window);
    const turns = page.turns;
    // Scope the two batched reads to the SAME seq range as the turns, so a
    // window costs a window's rows and the batching composes with it.
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

  /**
   * Archive-aware transcript load (issue #438 decision 9, wave 3). Serves live
   * rows as `getSession` does, and — when the conversation has custody-gated-
   * PRUNED archive ranges — fetches each range's sealed segment blob via the
   * injected reader, decodes it, and merges the archived turns back in by seq,
   * marked `fromArchive`. READ-ONLY: rehydrated turns are ephemeral (nothing is
   * re-inserted); mutation paths keyed by turn id no-op on them because the raw
   * rows are gone. A fetch failure yields the live rows + `archiveUnavailable`
   * rather than a silently partial thread.
   */
  async getSessionRehydrated(
    appId: string,
    id: string,
    window: TranscriptWindow = {}
  ): Promise<SessionTranscript | undefined> {
    const { store } = this.appConversation(appId);
    const meta = this.ownedMeta(appId, id);
    if (!meta) return undefined;

    const prunedRefs = store.listArchiveSegments(id).filter((r) => r.pruned);
    // Fast path: no pruned range ⇒ every turn is still a live row (an
    // archived-but-unpruned range serves from live rows too, no blob fetch).
    if (prunedRefs.length === 0) return this.getSession(appId, id, window);

    const archived = await collectArchivedRows(
      this.archiveBlobReader,
      prunedRefs
    );

    const liveTurns = store.listTurns(id);
    const itemsByTurn = store.listItemsByTurn(id);
    const attachmentsByItem = store.listAttachmentsByItem(id);
    // Archived turns can never collide with live ids (pruned rows are gone).
    for (const [turnId, items] of archived.itemsByTurn)
      itemsByTurn.set(turnId, items);

    const merged = [...archived.turns, ...liveTurns].sort(
      (a, b) => a.seq - b.seq
    );
    // Windowing happens AFTER the merge on this path, in memory (issue #659
    // G5). The archive segments have to be fetched and decoded whole either
    // way, so pushing the window into SQL would window only the live half and
    // report `hasMore` against a partial picture. Cost is unchanged from
    // before; correctness across the archive boundary is what is bought.
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

  /** Attachment metadata + download URL for a message item's attachments. */
  private attachmentsPayload(
    appId: string,
    itemId: string
  ): ConversationAttachmentPayload[] {
    const { store } = this.appConversation(appId);
    return attachmentPayloads(appId, store.listAttachmentsForItem(itemId));
  }

  /** Persist uploaded bytes to the app's blob CAS (dedup by content hash). */
  uploadBlob(appId: string, bytes: Uint8Array): Promise<PutResult> {
    return this.blobs.put(appId, bytes);
  }

  /** Read attachment bytes back from the CAS (for the download route). */
  readBlob(appId: string, hash: string): Promise<Buffer | undefined> {
    return this.blobs.read(appId, hash);
  }

  /** Absolute on-disk path of a blob — the multimodal harness reads it. */
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

  /**
   * FTS5 search over this app's chat/build sessions — titles + inbound message
   * text (issue #420). Powers the ⌘K palette's "Conversations" category. Each
   * result carries a highlighted `snippet` for match context.
   */
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

  /** Pin/unpin a session `appId` owns; returns the fresh summary or undefined. */
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

  /** Archive/unarchive a session `appId` owns; returns the fresh summary. */
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

  /**
   * Set (or clear, with `null`) the reader's 👍/👎 on one turn's answer in a
   * session `appId` owns (issue #420). Returns whether it was applied — false
   * when the session isn't owned or the turn isn't part of it.
   *
   * Read-only archived history (issue #438 wave 3): a custody-gated-PRUNED turn's
   * raw row is gone, so this UPDATE matches nothing and returns false — the route
   * answers 404. Mutating rehydrated (sealed) history is thereby structurally
   * impossible; an archived-but-unpruned turn still has its row and stays
   * mutable, as it should.
   */
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
    // Real FK CASCADE drops the conversation's turns, items, and attachment
    // rows; a follow-up blob GC reclaims now-unreferenced bytes (issue #190).
    const { store } = this.appConversation(appId);
    if (!this.ownedMeta(appId, id)) return false;
    const ok = store.deleteConversation(id, this.currentUserId());
    if (ok)
      void this.blobs
        .gc(appId, store.referencedHashes())
        .catch(() => undefined);
    return ok;
  }

  /**
   * Persist one completed chat turn: a `turns` row, its ordinal-0 `message_in`
   * item (plus any attachments), and the assistant/tool `items`, in the active
   * vault's `journal.db`. Returns `undefined` when the conversation doesn't
   * exist there — including the mid-turn vault-switch case, which thereby fails
   * closed (#280) — or is owned by another user. The first turn names the
   * conversation.
   */
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
      // Trace items start at ordinal 1 — the inbound message is ordinal 0.
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

  /**
   * Look up an already-recorded turn by its client idempotency key (issue #420).
   * Returns the replayable answer (final text or error + usage) so the turn
   * route can stream a duplicate POST's result straight from the ledger instead
   * of re-running the model. Undefined when no turn with that key exists on the
   * conversation, or the conversation isn't owned by `appId`.
   */
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

  /** Bump turn_count + persist the harness-resume handle. */
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

  /** Internal ACP resume state; unlike `ConversationSummary`, never crosses the client wire. */
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
    // A targeted lookup asks only for that harness's resumable binding.
    // Falling back to the conversation's different active harness would
    // pair the wrong opaque session id with the requested harness. A miss is
    // `undefined` — an empty object reads as "state found, all fields absent"
    // at every call site that only truthiness-tests the result.
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

  /**
   * Live, custody-safe delta for an ACP binding. Pruned/archive-custody rows
   * never enter this path; only turns still present in the canonical ledger
   * after the binding's watermark are folded.
   */
  getHydrationDelta(
    appId: string,
    conversationId: string,
    afterSeq: number
  ): { messages: ConversationMessageRow[]; throughSeq: number } | undefined {
    const { store } = this.appConversation(appId);
    if (!this.ownedMeta(appId, conversationId)) return undefined;
    const all = store.listTurns(conversationId);
    // `seq` starts at 0, so the empty-ledger watermark is -1 — 0 would claim
    // the first turn was already hydrated.
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

/** Inputs to the transcript fold — live-only or live-merged-with-archived. */
interface TranscriptSources {
  /** Turns to render, ascending by seq (archived + live merged for rehydration). */
  turns: Turn[];
  /** Each turn's items (from the ledger for live turns, the segment for archived). */
  itemsByTurn: Map<string, Item[]>;
  /** Attachment payloads for a `message_in` item (ledger query or segment rows). */
  attachmentsOf: (itemId: string) => ConversationAttachmentPayload[];
  /** True when a turn was rehydrated from a pruned segment — marks it read-only. */
  isArchived: (turnId: string) => boolean;
}

/**
 * Reconstruct the renderer transcript from turns + their items (issue #190),
 * collapsing retry families into one row per family with a sibling pager
 * (issue #420). A rehydrated turn (issue #438 wave 3) marks each of its message
 * payloads `fromArchive: true` so the surface renders a "from the archive"
 * state; nothing else about the row changes. Pure — no store access — so the
 * live path and the archive-merged path share exactly one fold.
 */
function foldTranscript(src: TranscriptSources): ConversationMessageRow[] {
  const { turns, itemsByTurn, attachmentsOf, isArchived } = src;
  const messages: ConversationMessageRow[] = [];
  let idx = 0;

  // The terminal `step` item's parsed answer for a turn — the one attempt text
  // the retry pager flips between (issue #420).
  const answerOf = (turnId: string): { text: string; error: boolean } => {
    const last = (itemsByTurn.get(turnId) ?? []).findLast(
      (it) => it.kind === "step"
    );
    return parseStepOutput(last?.outputJson);
  };

  // Per-turn token/cost usage for the "this turn cost X" line (issue #420,
  // Wave 2). Token sums + cost are the frozen denormalized rollup on the turn;
  // the serving model comes off the terminal step. Absent on unpriced/legacy.
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

  // Collapse retries linear-with-retry: one row per *family*, showing the
  // latest attempt inline, with sibling attempts carried for a client pager.
  for (const family of groupRetryFamilies(turns)) {
    const root = family[0] as Turn;
    const active = family.at(-1) as Turn;
    // A family archives/prunes as one contiguous range, so it is homogeneous —
    // the root's archived state stands for the whole family.
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

    // The user message rides once, from the root attempt (every retry
    // re-sends the same prompt).
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
        // Only the terminal step carries turn identity / feedback / the retry
        // pager — interim steps stay plain.
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
    // Prefer harness/ACP cost; else catalog estimate; else NULL (issue #514).
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

/**
 * Inclusive `seq` bounds of a turn page — scopes the batched item/attachment
 * reads to the same window as the turns (issue #659 G5).
 */
function seqRangeOf(turns: readonly Turn[]): {
  fromSeq?: number;
  toSeq?: number;
} {
  if (turns.length === 0) return {};
  return { fromSeq: turns[0]!.seq, toSeq: turns.at(-1)!.seq };
}

/**
 * The in-memory equivalent of `listTurnWindow`, for the archive-merged path
 * where the window cannot be expressed in SQL. Same contract: strictly older
 * than `beforeSeq`, newest `limit` of what remains, oldest-first, and
 * `hasMore` iff something was cut from the older end.
 */
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

/**
 * Attachment rows → the wire payload. One mapper for both sources — live rows
 * and rehydrated archive rows — so the two can never drift over the one
 * batched read per conversation (#659 G5).
 */
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

// HTTP route dispatcher lives in conversation-routes.ts to keep this file
// focused on the facade + fold. Re-exported below from the package index.
