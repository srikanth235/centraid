// THE ONE DECODER for a canonical body (#996, rulings R4 / R8).
//
// Canonical note/message/document bodies are not prose columns — they are
// data: URIs on the referenced `core_content_item` (rent the bytes, own the
// reference). Something has to turn those bytes into text, and until #996
// that something was an application-defined SQL function the FTS triggers
// called, which only `openVaultDb` could register. That is precisely what
// pinned the search index to the gateway: expo-sqlite exposes no way to
// register a SQL function, and a trigger has to index a COLUMN.
//
// So the decode moved to WRITE time (`schema/representation.ts`, which writes
// `core_content_text`), and it lives here rather than in `schema/fts.ts`
// because it is no longer an FTS concern: the index reads a column now, and
// this function's callers are the writer and the portable-export adapters.

/** Decoded text of a canonical body, or null for anything non-text. */
export function contentText(
  mediaType: unknown,
  contentUri: unknown
): string | null {
  if (typeof mediaType !== "string" || !mediaType.startsWith("text/"))
    return null;
  if (typeof contentUri !== "string" || !contentUri.startsWith("data:"))
    return null;
  const comma = contentUri.indexOf(",");
  if (comma < 0) return null;
  const meta = contentUri.slice(0, comma);
  const payload = contentUri.slice(comma + 1);
  try {
    return meta.includes(";base64")
      ? Buffer.from(payload, "base64").toString("utf8")
      : decodeURIComponent(payload);
  } catch {
    return null;
  }
}
