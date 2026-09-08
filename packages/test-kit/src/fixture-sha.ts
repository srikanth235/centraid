import { createHash } from "node:crypto";

/**
 * A syntactically real sha256 for a fixture (#996, ruling R21).
 *
 * `core_content_item.sha256` is CHECKed to sixty-four hex characters since the
 * content write became one operation over hash, size and bytes — the column IS
 * the dedupe key for every owner of those bytes, and nothing held its shape.
 * Fixtures that wanted "some hash here" said `'sha-note-body'` or `'h1'`; they
 * say this instead, which is stable per seed and is a hash of something.
 */
export function fixtureSha(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}
