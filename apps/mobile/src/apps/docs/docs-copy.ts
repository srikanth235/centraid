// The phone's own status sentences (Binding Layer v12 handoff Part 2;
// #821) — every screen-level shelf status the handoff's `docsCfg` table
// prints, with the sample numbers replaced by the member's real counts (the
// shared `view-copy.ts` header names that as the one licensed departure).
//
// Sentences the SHARED copy modules already carry are imported at their call
// sites, never restated here; this file holds only the compositions the web
// app does not need (its status line is built by `frame.tsx`).
//
// Pure and react-free so the words can be asserted directly.

const fmt = (n: number): string => n.toLocaleString("en-US");

/** The All shelf's mobile status (`docsCfg.list.mobStatus`):
 *  `1,908 · press and hold a row for quick actions`. */
export function allStatus(count: number): string {
  return `${fmt(count)} · press and hold a row for quick actions`;
}

/** `docsCfg.folders.status`: `4 folders · a folder is a label, not a place`. */
export function foldersStatus(count: number): string {
  return `${fmt(count)} ${count === 1 ? "folder" : "folders"} · a folder is a label, not a place`;
}

/** `docsCfg.trash.status`: `9 in trash · each purged 30 days after it was
 *  deleted`. */
export function trashStatus(count: number): string {
  return `${fmt(count)} in trash · each purged 30 days after it was deleted`;
}

/**
 * The Starred shelf's status. The spec's sample adds `12 documents, 6
 * photographs`; the photograph half is WITHHELD on the phone — Docs' replica
 * scope reads document tags only, so a photograph count here would be a
 * number this app never read (see INTEGRATION-NOTES.md).
 */
export function starredStatus(count: number): string {
  return `${fmt(count)} starred`;
}

/**
 * The Search shelf's status (`docsCfg.search.status`), phone-honest: this
 * device's replica indexes TITLES, so every document is one the search could
 * not look inside. The could-not-read count is therefore the whole drive,
 * stated rather than hidden — the state the handoff says no other app needs.
 */
export function searchStatus(results: number, couldNotRead: number): string {
  return `${fmt(results)} ${results === 1 ? "result" : "results"} · searched titles · ${fmt(couldNotRead)} documents could not be looked inside`;
}

/** One folder's status (`docsCfg.folder.status` shape:
 *  `Property · 38 documents · 6 shown`, the shown clause only under filter). */
export function folderStatus(
  name: string,
  count: number,
  shown?: number
): string {
  const base = `${name} · ${fmt(count)} ${count === 1 ? "document" : "documents"}`;
  return shown !== undefined && shown !== count
    ? `${base} · ${fmt(shown)} shown`
    : base;
}

/** The phone search field's promise — deliberately NOT the web
 *  `SEARCH_PLACEHOLDER` ("Search titles and contents"): this device's replica
 *  index reaches titles, and the field may not promise more than the read
 *  behind it (drive-copy.ts says mobile "owes a different sentence"). */
export const MOBILE_SEARCH_PLACEHOLDER = "Search titles";
export const MOBILE_SEARCH_LABEL = "Search documents by title";

/** The Search shelf's resting state — People's own idle sentence. */
export const SEARCH_IDLE = "Type to search.";

/**
 * Coming due, honestly absent: obligations are read out of documents by the
 * `due` capability, which is a consent that is OFF and has no runner in this
 * wave (blueprints/apps/docs/capabilities.ts). The screen states the absence
 * and routes to the consent, rather than staging a guess — "a date with no
 * passage is a guess, and a guess must not enter the member's calendar."
 */
export const DUE_EMPTY_TITLE = "Nothing has been read";
export const DUE_EMPTY_ACTION = "What Docs may read";
export function dueEmptyBody(what: string): string {
  return `${what} Each capability is a separate consent, and this one is off.`;
}

/**
 * Storage, on the phone: custody counts are replica facts and are shown; the
 * byte totals the desktop screen prints come from a gateway storage read this
 * seat does not have, so the figures are withheld and the absence is stated.
 */
export const STORAGE_WITHHELD =
  "Byte totals come from the gateway's own storage read, which this phone does not have; what is counted here is what this device's replica reports.";
export function storageStatus(count: number): string {
  return `${fmt(count)} ${count === 1 ? "document" : "documents"}`;
}

/** The custody categories the Storage screen counts, in the words
 *  `format.ts`'s custody table already uses for the same states. */
export const STORAGE_ROWS: readonly { state: string; label: string }[] = [
  { state: "local-only", label: "On this device only" },
  { state: "replicated", label: "Backed up" },
  { state: "remote-only", label: "Only in the cloud" },
  { state: "missing", label: "Missing — needs attention" },
];

// ───────────────────────────────────────────────────────────────────────────
// One document's screens (the document-level slice of #821) — appended
// by the sibling agent, additively, per INTEGRATION-NOTES.md.
// ───────────────────────────────────────────────────────────────────────────

/** §7's status, verbatim: the facts panel's one standing sentence. */
export const FACTS_STATUS =
  "Docs cannot set this kind · nothing has been converted";

/** §10's status: `7 versions · version 7 is current · nothing is ever
 *  overwritten` — the count is the real chain length, never the sample's. */
export function versionsStatus(count: number): string {
  return `${fmt(count)} ${count === 1 ? "version" : "versions"} · version ${fmt(count)} is current · nothing is ever overwritten`;
}

/** WHO made each version is a `consent.provenance` fact this phone's replica
 *  does not carry — stated on the screen, never guessed. */
export const VERSIONS_WHO_WITHHELD =
  "Who made each version is the vault's provenance record, which this phone does not hold; the chain itself is the vault's own.";

/** The chain read failed or was denied — the honest absence, not an empty
 *  fabricated history. */
export const VERSIONS_ABSENT =
  "This device could not read the version links, so no history is shown";

/** §11: the backup timestamp is the gateway's own fact; no read for it here. */
export const PROPERTIES_BACKUP_WITHHELD =
  "When it was last backed up is the gateway's own record; this phone has no read for it and will not guess a time.";

/** §12's status — real: `capabilitiesOnCount()` is zero on this wave. */
export function capabilitiesStatus(onCount: number): string {
  return onCount === 0
    ? "Nothing is running · each capability is a separate consent"
    : `${fmt(onCount)} running · each capability is a separate consent`;
}

/** Why the capabilities screen draws NO switch: there is no consent record to
 *  write, and a control that flips nothing would be a promise, not a consent. */
export const CAPABILITY_SWITCH_WITHHELD =
  "No consent record yet — this screen draws no switch";

/** §12's two capability-product screens, honest at zero. */
export function filingStatus(count: number): string {
  return `${fmt(count)} ${count === 1 ? "proposal" : "proposals"} · nothing has been filed`;
}
export function namesStatus(count: number): string {
  return `${fmt(count)} ${count === 1 ? "link" : "links"} · each carries the passage it was read from`;
}

/** §13's status, verbatim — true on this screen: uploads run on Bulk upload. */
export const ADD_STATUS = "Nothing is uploading";

/** §13's honest partial failure: `9 of 12 landed · 3 did not · nothing was
 *  discarded`, with the member's real counts. */
export function bulkStatus(
  landed: number,
  failed: number,
  total: number
): string {
  return `${fmt(landed)} of ${fmt(total)} landed · ${fmt(failed)} did not · nothing was discarded`;
}

/** §14, phone-honest: the frame's Scan cover is the one camera entrance, and
 *  what it lands today is a single-page image document with its reviewed
 *  text — the multi-page-PDF assembly has no machinery on this seat yet. */
export const SCAN_HANDOFF_BODY =
  "Scan cover: one capture, reviewed here, saved into Docs as an image with its extracted text";
export const SCAN_PDF_WITHHELD =
  "Multi-page capture that lands as one PDF is not built on this phone yet, so this screen does not promise it.";
