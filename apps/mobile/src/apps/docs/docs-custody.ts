// Custody altitude for Docs (issue #712 B4, docs/blueprint-seats.md "Byte
// custody vocabulary"). Pure, so each rule can be asserted directly — the
// same shape as Photos' `tile-overlays.ts`, at row scale instead of tile
// scale.
//
// `blob.custody_state` (packages/vault/src/blob/custody-state.ts) carries
// five tokens: `pending-offsite | local-only | replicated | remote-only |
// missing`. The doctrine's per-row rule is the exception ONLY, as a mark,
// never a sentence:
//
//   - `local-only` is the one state a member can lose something to — a
//     scanned document that exists on this phone and nowhere else is one
//     device-loss away from gone. It is the row's mark, mirroring Photos'
//     `stateOverlay` custody case exactly (same icon, same label).
//   - `replicated` and `remote-only` are the two steady states the triple
//     names — they say nothing at row altitude. Their full story is told in
//     DocumentViewer (the per-item altitude, on demand).
//   - `pending-offsite` is the transient seconds between local-only and
//     replicated — like Photos' `queued`/`uploading`, it falls through to no
//     mark rather than blinking one on and off row by row as the upload
//     queue drains.
//   - `missing` is a distinct integrity failure (bytes on NEITHER tier), not
//     a custody-location fact the triple describes — out of scope for this
//     row mark, same as it is absent from Photos' triple.
//
// The per-shelf altitude (the population count, "N on this device only") and
// the per-item altitude (DocumentViewer's full sentence) both read the same
// `local-only` token through their own small helpers below, so the three
// altitudes never drift into disagreeing about which token means what.

import type { NativeDocument } from "./docs-model";

/** The registry key for the custody mark: the same cloud-with-a-slash glyph
 *  Photos uses (`packages/design/src/icons.ts`) — deliberately the shape
 *  members have already learned, not a second glyph for the same fact. */
export const DOCS_CUSTODY_ICON = "CloudOff";

/** What the mark contributes to the row's accessibility label — the glyph is
 *  decorative by the icon contract (DESIGN.md:449), so the meaning has to
 *  reach a screen reader through an accessible label, not the icon itself. */
export const DOCS_CUSTODY_LABEL = "not backed up";

/** Copy for the per-shelf population count ("N on this device only", the
 *  altitude Backup Health's own legend already teaches the mark with). */
export const DOCS_CUSTODY_SHELF_SUFFIX = "on this device only";

/** True only for the one custody state a member can lose something to. */
export function marksLocalOnly(custody: NativeDocument["custody"]): boolean {
  return custody === "local-only";
}

/** The per-shelf population fact: how many of the given documents are the
 *  loss-risk exception right now. Zero renders nothing (a shelf line does
 *  not narrate an empty set any more than a tile marks the steady state). */
export function countLocalOnly(documents: readonly NativeDocument[]): number {
  return documents.reduce(
    (count, document) => count + (marksLocalOnly(document.custody) ? 1 : 0),
    0
  );
}

/** The per-item full story (DocumentViewer's on-demand altitude): an honest
 *  sentence for every token the vault can assert, in the same vocabulary
 *  Photos' viewer already teaches ("on this device only" / "backed up" /
 *  "on the gateway") — never a raw token, and never a silent "local" guess
 *  for a state the vault has not actually reported. */
export function custodySentence(custody: NativeDocument["custody"]): string {
  switch (custody) {
    case "local-only":
      return "on this device only";
    case "replicated":
      return "backed up";
    case "remote-only":
      return "on the gateway";
    case "pending-offsite":
      return "backing up now";
    case "missing":
      return "missing — needs attention";
    case undefined:
      return "backup status unknown";
    default:
      return "backup status unknown";
  }
}
