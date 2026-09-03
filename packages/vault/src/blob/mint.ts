import type { HandlerCtx } from "../gateway/types.js";
import { sha256OfBytes, blobUriFor } from "./store.js";

export const MAX_INLINE_DATA_URI_CHARS = 360_000;

export interface DecodedDataUri {
  mediaType: string;
  bytes: Buffer;
}

export function decodeDataUri(uri: string): DecodedDataUri {
  if (!uri.startsWith("data:")) throw new Error("payload must be a data: URI");
  const comma = uri.indexOf(",");
  if (comma === -1) throw new Error("malformed data: URI (no comma)");
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  const isBase64 = meta.split(";").includes("base64");
  const mediaType = meta.split(";")[0] || "application/octet-stream";
  const bytes = isBase64
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");
  return { mediaType, bytes };
}

export interface MintedContent {
  contentId: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  deduped: 0 | 1;
}

export function mintContentFromDataUri(
  ctx: HandlerCtx,
  uri: string,
  options: { title?: string } = {}
): MintedContent {
  const { mediaType, bytes } = decodeDataUri(uri);
  const sha = sha256OfBytes(bytes);
  const existing = ctx.db
    .prepare(
      "SELECT content_id, media_type, deleted_at FROM core_content_item WHERE sha256 = ?"
    )
    .get(sha) as
    | { content_id: string; media_type: string; deleted_at: string | null }
    | undefined;
  if (existing) {
    if (existing.deleted_at !== null || options.title) {
      ctx.db
        .prepare(
          `UPDATE core_content_item SET deleted_at = NULL, purge_at = NULL,
                  title = COALESCE(?, title) WHERE content_id = ?`
        )
        .run(options.title ?? null, existing.content_id);
      ctx.wrote("core.content_item", existing.content_id);
    }
    return {
      contentId: existing.content_id,
      mediaType: existing.media_type,
      byteSize: bytes.length,
      sha256: sha,
      deduped: 1,
    };
  }
  let contentUri: string;
  if (mediaType.startsWith("text/")) {
    contentUri = uri;
  } else {
    const spilled = ctx.blobs.spill(bytes);
    if (spilled !== sha)
      throw new Error("spill produced a different sha — refusing to mint");
    contentUri = blobUriFor(sha);
  }
  const contentId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title, language, creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)`
    )
    .run(
      contentId,
      mediaType,
      contentUri,
      sha,
      bytes.length,
      options.title ?? null,
      ctx.identity.partyId,
      ctx.now
    );
  ctx.wrote("core.content_item", contentId);
  return {
    contentId,
    mediaType,
    byteSize: bytes.length,
    sha256: sha,
    deduped: 0,
  };
}
