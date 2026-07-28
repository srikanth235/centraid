/*
 * The chat-history surface of the conversation client (issue #141, Phase 3;
 * split out of `gateway-client-conversation.ts` under issue #599, which pushed
 * that file past the size limit). Routes single-sourced in
 * `@centraid/blueprints/kit/conversation-client.js` (#420).
 *
 * Every read/write here takes an optional `scopeId`: a conversation row lives in
 * exactly ONE space, so once its space is known the client must name it rather
 * than let the ambient default-scope pointer decide (#599, Decision 14).
 * Omitted, the request falls back to that pointer — which is how every
 * conversation created before the picker existed keeps working.
 *
 * Re-exported from `gateway-client-conversation.ts` so call sites keep importing
 * the whole conversation surface from one place.
 */

import {
  conversationsPath,
  conversationPath,
  conversationSearchPath,
  blobsPath,
} from "@centraid/blueprints/kit/conversation-client.js";

import {
  auth,
  authHeaders,
  doFetch,
  readJson,
  scopedAuthHeaders,
  GatewayClientError,
} from "./gateway-client-core.js";

// ───────────────────────── chat history ─────────────────────
// Routes single-sourced in @centraid/blueprints/kit/conversation-client.js (#420).

/** List this app's persisted chat sessions, newest first. */
export async function listConversations(
  appId: string
): Promise<CentraidConversationSummary[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, conversationsPath(appId), {
    method: "GET",
    headers: authHeaders(token),
  });
  const out = await readJson<{ sessions: CentraidConversationSummary[] }>(
    res,
    "list chats"
  );
  return out.sessions ?? [];
}

/** Create a fresh chat session row (the chat session id the turn streams to).
 *  `scopeId` pins the new conversation to one space (issue #599) — the row is
 *  written there, so every later load/turn must name the same space. */
export async function createConversation(
  appId: string,
  title = "",
  scopeId?: string
): Promise<CentraidConversationSummary> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, conversationsPath(appId), {
    method: "POST",
    headers: scopedAuthHeaders(token, scopeId, "application/json"),
    body: JSON.stringify({ title }),
  });
  return readJson<CentraidConversationSummary>(res, "create chat");
}

/**
 * Fetch an attachment blob's bytes (auth-aware) and return an object URL for an
 * inline `<img>` thumbnail (issue #420, Wave 2). The blob GET route lives behind
 * the same bearer auth as the rest of the conversation surface, so an `<img
 * src>` cannot carry it — we fetch the bytes and mint a local object URL. The
 * caller must `URL.revokeObjectURL` it when the image unmounts.
 */
export async function fetchAssistantAttachmentUrl(
  appId: string,
  hash: string,
  mime: string
): Promise<string> {
  const { baseUrl, token } = await auth();
  const path = `${blobsPath(appId)}/${encodeURIComponent(hash)}?mime=${encodeURIComponent(mime)}`;
  const res = await doFetch(baseUrl, path, {
    method: "GET",
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new GatewayClientError(
      "gateway_error",
      `attachment fetch failed (HTTP ${res.status})`
    );
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/**
 * Load one chat session with its reconstructed transcript. When cold ranges
 * were archived + custody-gated-pruned (issue #438 wave 3), the server merges
 * them back read-only: `hasArchivedHistory` flags that some messages carry
 * `fromArchive`, and `archiveUnavailable` flags that a segment blob couldn't be
 * fetched (the render is the live rows only).
 */
export async function loadConversation(
  appId: string,
  sessionId: string,
  scopeId?: string
): Promise<
  CentraidConversationSummary & {
    messages: Array<{
      idx: number;
      payload: CentraidConversationHistoryMessage;
      createdAt: number;
    }>;
    hasArchivedHistory?: boolean;
    archivedTurnCount?: number;
    archiveUnavailable?: boolean;
    /**
     * The conversation's persisted workspace selection (#567): the Centraid-owned
     * primary root plus any owner-approved extra directories. Absent on
     * conversations created before the selector existed.
     */
    workspace?: {
      primaryKind: "vault-data" | "app" | "draft";
      additionalDirectories: string[];
      updatedAt: number;
    };
  }
> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, conversationPath(appId, sessionId), {
    method: "GET",
    headers: scopedAuthHeaders(token, scopeId),
  });
  return readJson(res, "load chat");
}

/** Rename a chat session. */
export async function renameConversation(
  appId: string,
  sessionId: string,
  title: string,
  scopeId?: string
): Promise<void> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, conversationPath(appId, sessionId), {
    method: "PATCH",
    headers: scopedAuthHeaders(token, scopeId, "application/json"),
    body: JSON.stringify({ title }),
  });
  await readJson(res, "rename chat");
}

/**
 * FTS search over this app's chat sessions — titles + inbound message text
 * (issue #420). Powers the ⌘K palette's "Conversations" category. Each hit
 * carries a highlighted `snippet` for match context; archived threads are
 * excluded server-side.
 */
export async function searchConversations(
  appId: string,
  query: string,
  limit = 20
): Promise<CentraidConversationSearchResult[]> {
  if (!query.trim()) return [];
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    conversationSearchPath(appId, query, limit),
    {
      method: "GET",
      headers: authHeaders(token),
    }
  );
  const out = await readJson<{ results: CentraidConversationSearchResult[] }>(
    res,
    "search chats"
  );
  return out.results ?? [];
}

/** Pin or unpin a chat session (pinned threads sort first). */
export async function setConversationPinned(
  appId: string,
  sessionId: string,
  pinned: boolean,
  scopeId?: string
): Promise<void> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, conversationPath(appId, sessionId), {
    method: "PATCH",
    headers: scopedAuthHeaders(token, scopeId, "application/json"),
    body: JSON.stringify({ pinned }),
  });
  await readJson(res, "pin chat");
}

/** Archive or unarchive a chat session. */
export async function setConversationArchived(
  appId: string,
  sessionId: string,
  archived: boolean,
  scopeId?: string
): Promise<void> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, conversationPath(appId, sessionId), {
    method: "PATCH",
    headers: scopedAuthHeaders(token, scopeId, "application/json"),
    body: JSON.stringify({ archived }),
  });
  await readJson(res, "archive chat");
}

/**
 * Set (or clear, with `null`) the reader's 👍/👎 on one answer turn
 * (`PATCH .../sessions/<id>/turns/<turnId>/feedback`, issue #420).
 */
export async function setConversationFeedback(
  appId: string,
  sessionId: string,
  turnId: string,
  feedback: "up" | "down" | null
): Promise<void> {
  const { baseUrl, token } = await auth();
  const path = `${conversationPath(appId, sessionId)}/turns/${encodeURIComponent(turnId)}/feedback`;
  const res = await doFetch(baseUrl, path, {
    method: "PATCH",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify({ feedback }),
  });
  await readJson(res, "set feedback");
}

/** Delete a chat session. */
export async function deleteConversation(
  appId: string,
  sessionId: string,
  scopeId?: string
): Promise<void> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, conversationPath(appId, sessionId), {
    method: "DELETE",
    headers: scopedAuthHeaders(token, scopeId),
  });
  await readJson(res, "delete chat").catch(() => undefined);
}
