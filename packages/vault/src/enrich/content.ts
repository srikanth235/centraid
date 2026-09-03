import { resolveServableBlob } from "../blob/read.js";
import type { VaultDb } from "../db.js";

export const AGENT_CONTENT_VARIANTS = [
  "original",
  "thumb",
  "preview",
  "poster",
  "text",
  "transcript",
] as const;
export type AgentContentVariant = (typeof AGENT_CONTENT_VARIANTS)[number];

export const AGENT_CONTENT_DEFAULT_MAX_BYTES = 1024 * 1024;
export const AGENT_CONTENT_HARD_MAX_BYTES = 4 * 1024 * 1024;
export const AGENT_CONTENT_ORIGINAL_HARD_MAX_BYTES = 64 * 1024 * 1024;
export const AGENT_CONTENT_MAX_TEXT_CHARS = 262_144;

export type AgentContentOutcome =
  | {
      status: "ok";
      kind: "bytes";
      mediaType: string;
      byteSize: number;
      base64: string;
    }
  | {
      status: "ok";
      kind: "text";
      mediaType: string;
      text: string;
      truncated: boolean;
    }
  | { status: "not-found" }
  | { status: "no-variant" }
  | { status: "too-large"; byteSize: number; maxBytes: number };

export async function resolveAgentContent(
  db: VaultDb,
  contentId: string,
  variant: AgentContentVariant,
  maxBytes?: number
): Promise<AgentContentOutcome> {
  if (variant === "text" || variant === "transcript") {
    const row = db.vault
      .prepare(
        `SELECT d.text_content FROM core_content_derivative d
           JOIN core_content_item i ON i.content_id = d.content_id
          WHERE d.content_id = ? AND d.variant = ? AND i.deleted_at IS NULL`
      )
      .get(contentId, variant) as { text_content: string | null } | undefined;
    if (!row) {
      const exists = db.vault
        .prepare(
          "SELECT 1 AS n FROM core_content_item WHERE content_id = ? AND deleted_at IS NULL"
        )
        .get(contentId);
      return exists ? { status: "no-variant" } : { status: "not-found" };
    }
    const text = row.text_content ?? "";
    const truncated = text.length > AGENT_CONTENT_MAX_TEXT_CHARS;
    return {
      status: "ok",
      kind: "text",
      mediaType: "text/plain",
      text: truncated ? text.slice(0, AGENT_CONTENT_MAX_TEXT_CHARS) : text,
      truncated,
    };
  }
  const original = variant === "original";
  const cap = Math.min(
    maxBytes ?? AGENT_CONTENT_DEFAULT_MAX_BYTES,
    original
      ? AGENT_CONTENT_ORIGINAL_HARD_MAX_BYTES
      : AGENT_CONTENT_HARD_MAX_BYTES
  );
  const outcome = resolveServableBlob(
    db.vault,
    contentId,
    original ? undefined : variant
  );
  if (outcome.status !== "ok") {
    return outcome.status === "no-variant" || outcome.status === "not-blob"
      ? { status: "no-variant" }
      : { status: "not-found" };
  }
  if (
    original &&
    !outcome.blob.mediaType.startsWith("audio/") &&
    !outcome.blob.mediaType.startsWith("video/")
  ) {
    return { status: "no-variant" };
  }
  if (outcome.blob.byteSize > cap) {
    return {
      status: "too-large",
      byteSize: outcome.blob.byteSize,
      maxBytes: cap,
    };
  }
  const bytes = await db.blobs.open(outcome.blob.sha256);
  if (!bytes) return { status: "not-found" };
  return {
    status: "ok",
    kind: "bytes",
    mediaType: outcome.blob.mediaType,
    byteSize: bytes.length,
    base64: bytes.toString("base64"),
  };
}
