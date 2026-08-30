// A NOTE'S WORDS, out of the row that holds them (#883 B4).
//
// A canonical note body is an inline `data:` URI on `core_content`. Six places
// decoded one — five query handlers and the editor's own formatter — and four
// of the six called `atob` bare, which is the one thing the decoding rule
// forbids: `atob` yields BYTES, and reading them as characters mangles every
// multi-byte one. An em dash in a note came back as two mojibake glyphs on the
// library shelf and correctly in the editor, from the same row.
//
// `_shared/format-kit.ts` is the ruled decoder. What is Notes' own, and is
// therefore here rather than there, is what a body says when it is NOT inline
// prose this app can read — and that is two different sentences, not one:
//
//   * `(external content)` — the body is not a `data:` URI at all. It lives
//     somewhere this list cannot follow, and nothing is wrong.
//   * `(unreadable content)` — it IS an inline body and the decode failed. A
//     row that should have had words does not, and saying "external" would
//     hide a defect behind a normal-sounding phrase.
//
// Only Notes' `history` query drew that line before this pass; the other four
// said "external" for both. The line is kept, because it is the honest one.
import { decodeDataUri } from "../_shared/format-kit.ts";

export function decodeNoteBody(uri: unknown): string {
  if (typeof uri !== "string" || !uri.startsWith("data:"))
    return "(external content)";
  return decodeDataUri(uri) ?? "(unreadable content)";
}
