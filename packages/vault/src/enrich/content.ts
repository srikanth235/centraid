// Agent content access (issue #299 §2, resolving the #296 §7 seam): the
// size-bounded, variant-only byte primitive enrichers and the assistant read
// through. The structural rule lives here, not in policy: **derivatives
// egress, never originals.** A vision enricher reads the `preview` (or
// `thumb`) variant — GPS-stripped by the spool pipeline, a fraction of the
// original's bytes; a text enricher reads the inline `text` variant. There
// is deliberately no spelling of "give me the original" on this surface.
//
// Consent is the caller's problem (the gateway method evaluates the read and
// receipts it); this module only resolves and bounds.

import type { VaultDb } from '../db.js';
import { resolveServableBlob } from '../blob/read.js';

/** Variants an agent may read. `original` is intentionally absent. */
export const AGENT_CONTENT_VARIANTS = ['thumb', 'preview', 'text'] as const;
export type AgentContentVariant = (typeof AGENT_CONTENT_VARIANTS)[number];

/** Default / hard ceilings for one fetch (decoded bytes, text chars). */
export const AGENT_CONTENT_DEFAULT_MAX_BYTES = 1024 * 1024;
export const AGENT_CONTENT_HARD_MAX_BYTES = 4 * 1024 * 1024;
export const AGENT_CONTENT_MAX_TEXT_CHARS = 262_144;

export type AgentContentOutcome =
  | { status: 'ok'; kind: 'bytes'; mediaType: string; byteSize: number; base64: string }
  | { status: 'ok'; kind: 'text'; mediaType: string; text: string; truncated: boolean }
  | { status: 'not-found' }
  | { status: 'no-variant' }
  | { status: 'too-large'; byteSize: number; maxBytes: number };

/**
 * Resolve one content id's agent-readable variant. Binary variants ride the
 * same reachability derivation the blob routes use (`resolveServableBlob` —
 * content serves only when a model edge claims it); the text variant reads
 * the inline derivative row directly, same-transaction cheap.
 */
export async function resolveAgentContent(
  db: VaultDb,
  contentId: string,
  variant: AgentContentVariant,
  maxBytes?: number,
): Promise<AgentContentOutcome> {
  if (variant === 'text') {
    const row = db.vault
      .prepare(
        `SELECT d.text_content FROM core_content_derivative d
           JOIN core_content_item i ON i.content_id = d.content_id
          WHERE d.content_id = ? AND d.variant = 'text' AND i.deleted_at IS NULL`,
      )
      .get(contentId) as { text_content: string | null } | undefined;
    if (!row) {
      const exists = db.vault
        .prepare('SELECT 1 AS n FROM core_content_item WHERE content_id = ? AND deleted_at IS NULL')
        .get(contentId);
      return exists ? { status: 'no-variant' } : { status: 'not-found' };
    }
    const text = row.text_content ?? '';
    const truncated = text.length > AGENT_CONTENT_MAX_TEXT_CHARS;
    return {
      status: 'ok',
      kind: 'text',
      mediaType: 'text/plain',
      text: truncated ? text.slice(0, AGENT_CONTENT_MAX_TEXT_CHARS) : text,
      truncated,
    };
  }
  const cap = Math.min(maxBytes ?? AGENT_CONTENT_DEFAULT_MAX_BYTES, AGENT_CONTENT_HARD_MAX_BYTES);
  const outcome = resolveServableBlob(db.vault, contentId, variant);
  if (outcome.status !== 'ok') {
    return outcome.status === 'no-variant' || outcome.status === 'not-blob'
      ? { status: 'no-variant' }
      : { status: 'not-found' };
  }
  if (outcome.blob.byteSize > cap) {
    return { status: 'too-large', byteSize: outcome.blob.byteSize, maxBytes: cap };
  }
  const bytes = await db.blobs.open(outcome.blob.sha256);
  if (!bytes) return { status: 'not-found' };
  return {
    status: 'ok',
    kind: 'bytes',
    mediaType: outcome.blob.mediaType,
    byteSize: bytes.length,
    base64: bytes.toString('base64'),
  };
}
