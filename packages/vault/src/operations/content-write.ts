// THE CONTENT WRITE OPERATION (#996, ruling R21; drift ONT-26).
//
// "Content write is one operation over hash, size and bytes." A content item
// is the identity of a byte string: the hash IS the bytes, which is why the
// column is `UNIQUE` and why dedupe is safe. Atlas could set that column to
// sixty-four zeroes while `content_uri` and `byte_size` stayed exactly where
// they were — a hash of nothing, over bytes that had not moved, silently
// re-pointing every dedupe decision the vault would ever make.
//
// Two questions, asked of every writer: is this a hash at all, and did the
// bytes it claims to summarise actually change?

import type { DatabaseSync } from "node:sqlite";

/** A stated field. `undefined` means "unchanged". */
type Stated<T> = T | null | undefined;

export interface ContentWriteDraft {
  readonly contentId: string | null;
  readonly sha256?: Stated<string>;
  readonly contentUri?: Stated<string>;
  readonly byteSize?: Stated<number>;
}

interface ContentRow {
  sha256: string;
  content_uri: string;
  byte_size: number;
}

const SHA256 = /^[0-9a-f]{64}$/u;

export interface ContentCondition {
  readonly name: string;
  readonly assert: (
    vault: DatabaseSync,
    draft: ContentWriteDraft,
    current: ContentRow | undefined
  ) => string | null;
}

export const CONTENT_WRITE_CONDITIONS: readonly ContentCondition[] = [
  {
    name: "content_hash_is_a_sha256",
    assert: (_vault, draft, current) => {
      const sha =
        draft.sha256 === undefined ? (current?.sha256 ?? null) : draft.sha256;
      if (sha === null) {
        return current === undefined
          ? "A content item is identified by the sha256 of its bytes; this one has none."
          : null;
      }
      return SHA256.test(sha)
        ? null
        : `sha256: ${JSON.stringify(sha)} is not a sha256 — sixty-four lowercase hex characters, and nothing else, identifies a byte string.`;
    },
  },
  {
    // The whole of ONT-26's second example. A hash summarises bytes: if the
    // bytes did not move, the summary cannot have changed, and a writer
    // claiming otherwise is corrupting the dedupe key for every owner of that
    // sha rather than describing anything.
    name: "content_hash_changes_only_with_bytes",
    assert: (_vault, draft, current) => {
      if (current === undefined || draft.sha256 === undefined) return null;
      if (draft.sha256 === null || draft.sha256 === current.sha256) return null;
      const uri =
        draft.contentUri === undefined ? current.content_uri : draft.contentUri;
      const size =
        draft.byteSize === undefined ? current.byte_size : draft.byteSize;
      if (uri !== current.content_uri || size !== current.byte_size)
        return null;
      return "The hash of a content item is the identity of its bytes — it cannot change while the bytes stay where they are.";
    },
  },
];

export function assertContentWrite(
  vault: DatabaseSync,
  draft: ContentWriteDraft
): { condition: string; message: string } | null {
  const current =
    draft.contentId === null
      ? undefined
      : (vault
          .prepare(
            "SELECT sha256, content_uri, byte_size FROM core_content_item WHERE content_id = ?"
          )
          .get(draft.contentId) as ContentRow | undefined);
  for (const condition of CONTENT_WRITE_CONDITIONS) {
    const message = condition.assert(vault, draft, current);
    if (message !== null) return { condition: condition.name, message };
  }
  return null;
}
