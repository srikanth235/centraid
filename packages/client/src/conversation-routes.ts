// The `_centraid-conversations/apps/<id>/…` route builders (issue #420) — the
// persisted-conversation surface the shell's conversation client reads and
// writes. These stay here rather than in `@centraid/protocol` because they are
// a flat top-level name with no plane prefix, which the protocol table forbids
// for new names (see packages/protocol/src/routes.ts and docs/protocol.md).
// Transport (auth headers, baseUrl) stays with the caller; only the URLs live
// here, so a route change lands once.

const enc = encodeURIComponent;

/** This app's persisted conversations (list/create). */
export function conversationsPath(appId: string): string {
  return `/_centraid-conversations/apps/${enc(appId ?? "")}/sessions`;
}

/** One conversation (load/rename/delete/pin/archive). */
export function conversationPath(appId: string, sessionId: string): string {
  return `${conversationsPath(appId)}/${enc(sessionId)}`;
}

/** FTS search over this app's conversations (issue #420). `q` is the raw query. */
export function conversationSearchPath(
  appId: string,
  query: string,
  limit?: number
): string {
  const params = new URLSearchParams();
  params.set("q", query ?? "");
  if (limit) params.set("limit", String(limit));
  return `${conversationsPath(appId)}/search?${params.toString()}`;
}

/**
 * Lightweight turn-settle poll for a conversation (issue #420). The reconnect
 * catch-up path GETs this after a mid-stream drop to learn whether the turn
 * finished server-side (`turnCount` climbed) before reloading the transcript.
 */
export function conversationStatusPath(
  appId: string,
  sessionId: string
): string {
  return `${conversationPath(appId, sessionId)}/status`;
}

/** This app's per-conversation attachment blob CAS (POST uploads). */
export function blobsPath(appId: string): string {
  return `/_centraid-conversations/apps/${enc(appId ?? "")}/blobs`;
}
