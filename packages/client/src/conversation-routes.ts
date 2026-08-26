// `_centraid-conversations/apps/<id>/…` route builders (#420); transport stays
// with the caller.

const enc = encodeURIComponent;

export function conversationsPath(appId: string): string {
  return `/_centraid-conversations/apps/${enc(appId ?? "")}/sessions`;
}

export function conversationPath(appId: string, sessionId: string): string {
  return `${conversationsPath(appId)}/${enc(sessionId)}`;
}

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

export function conversationStatusPath(
  appId: string,
  sessionId: string
): string {
  return `${conversationPath(appId, sessionId)}/status`;
}

export function blobsPath(appId: string): string {
  return `/_centraid-conversations/apps/${enc(appId ?? "")}/blobs`;
}
