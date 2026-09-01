// The phone's own status sentences (#821). Sentences the SHARED copy modules
// carry are imported at their call sites, never restated here.

import { fmtDate } from "@centraid/blueprints/apps/docs/format";

const fmt = (n: number): string => n.toLocaleString("en-US");

export function allStatus(count: number): string {
  return `${fmt(count)} · press and hold a row for quick actions`;
}

export function foldersStatus(count: number): string {
  return `${fmt(count)} ${count === 1 ? "folder" : "folders"} · a folder is a label, not a place`;
}

/** A folder row's own count, as prose — see the row for why not a figure. */
export function folderCount(count: number): string {
  return `${fmt(count)} ${count === 1 ? "document" : "documents"}`;
}

/** Unfiled is a condition, not a place; the row says which. */
export const UNFILED_NOTE = "never put in a folder — not an error";

export function trashStatus(count: number): string {
  return `${fmt(count)} in trash · each purged 30 days after it was deleted`;
}

/** Photograph count WITHHELD: Docs' replica scope reads document tags only. */
export function starredStatus(count: number): string {
  return `${fmt(count)} starred`;
}

// ─── Shared with you (the inbound half) ─────
//
// What this shelf can and cannot claim, stated once here so no surface has to
// re-derive it. `core_share_origin` is written when a share is DELIVERED into
// this vault, so its rows are the complete and only answer: a document with no
// row simply did not arrive that way. What the shelf cannot always say is WHO
// — naming the sender needs a live link binding for the origin vault, and
// without one the vault stays unnamed rather than wearing a truncated id.

export const SHARED_TITLE = "Shared with you";

export function sharedStatus(count: number): string {
  return `${fmt(count)} ${count === 1 ? "document" : "documents"} · each one arrived in your vault and is yours to keep`;
}

export const SHARED_CAPTION = "Sorted by when it reached you, newest first.";

/** Not an empty shelf: a shelf that does not know. The two must never look
 *  alike, so this replaces the set rather than captioning it. */
export const SHARED_UNKNOWN_TITLE = "This device cannot say what was shared";
export const SHARED_UNKNOWN_BODY =
  "Where a document came from is a separate read, and it did not answer. Rather than show you an empty shelf that would mean the wrong thing, this one shows nothing at all.";

export const SHARED_EMPTY_TITLE = "Nothing has been shared with you yet";
export const SHARED_EMPTY_BODY =
  "When someone you are linked with shares a document, a copy lands in your vault and appears here. It is yours from that moment — it stays if they unshare it, and it goes into your backup.";

/** The sender, unnamed where no link binding says whose vault it was. */
export const SHARED_SENDER_UNKNOWN = "Another vault";

/** The Shared row's lead line, in the slot a matched passage takes on Search:
 *  who sent it, and the day it landed. */
export function sharedFromLine(from: {
  name: string | null;
  at: number;
}): string {
  const who = from.name ?? SHARED_SENDER_UNKNOWN;
  const when = from.at ? fmtDate(new Date(from.at).toISOString()) : "";
  return when ? `${who} · ${when}` : who;
}

/** The replica indexes TITLES only; could-not-read counts the whole drive. */
export function searchStatus(results: number, couldNotRead: number): string {
  return `${fmt(results)} ${results === 1 ? "result" : "results"} · searched titles · ${fmt(couldNotRead)} documents could not be looked inside`;
}

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

/** Not the web `SEARCH_PLACEHOLDER`: this replica index reaches titles only. */
export const MOBILE_SEARCH_PLACEHOLDER = "Search titles";
export const MOBILE_SEARCH_LABEL = "Search documents by title";

export const SEARCH_IDLE = "Type to search.";

// What this search CANNOT reach, said BEFORE a query rather than after one.
//
// The handoff calls this "the state Photos never needed", and on the phone it
// is the whole drive: the replica indexes titles, so every result was matched
// on its name. Stating it only alongside results is the failure mode that
// matters — a member who searches a phrase they know is in a document, sees
// nothing, and concludes the document is gone. The absence has to be legible
// before the query that would mislead them.
export const SEARCH_REACH_EYEBROW = "What could not be searched";
export function searchReachTitle(count: number): string {
  return count === 1
    ? "1 document can be matched on its title only"
    : `${fmt(count)} documents can be matched on their titles only`;
}
export const SEARCH_REACH_BODY =
  "This device holds a copy of your documents' names, not of what is written inside them. Reading the contents is machine work and a separate consent, and it is off — so a phrase you remember from inside a document will not find it here.";
export const SEARCH_REACH_ACTION = "What Docs may read";

/** The `due` capability is off with no runner: state the absence, never guess. */
export const DUE_EMPTY_TITLE =
  "Nothing has been read out of your documents yet";
export const DUE_EMPTY_ACTION = "What Docs may read";
export function dueEmptyBody(what: string): string {
  return `${what} Each capability is a separate consent, and this one is off.`;
}

export const STORAGE_WITHHELD =
  "Byte totals come from the gateway's own storage read, which this phone does not have; what is counted here is what this device's replica reports.";
export function storageStatus(count: number): string {
  return `${fmt(count)} ${count === 1 ? "document" : "documents"}`;
}

export const STORAGE_ROWS: readonly { state: string; label: string }[] = [
  { state: "local-only", label: "On this device only" },
  { state: "replicated", label: "Backed up" },
  { state: "remote-only", label: "Only in the cloud" },
  { state: "missing", label: "Missing — needs attention" },
];

// ─── One document's screens (#821) ─────

export const FACTS_STATUS =
  "Docs cannot set this kind · nothing has been converted";

export function versionsStatus(count: number): string {
  return `${fmt(count)} ${count === 1 ? "version" : "versions"} · version ${fmt(count)} is current · nothing is ever overwritten`;
}

export const VERSIONS_WHO_WITHHELD =
  "Who made each version is the vault's provenance record, which this phone does not hold; the chain itself is the vault's own.";

export const VERSIONS_ABSENT =
  "This device could not read the version links, so no history is shown";

export const PROPERTIES_BACKUP_WITHHELD =
  "When it was last backed up is the gateway's own record; this phone has no read for it and will not guess a time.";

export function capabilitiesStatus(onCount: number): string {
  return onCount === 0
    ? "Nothing is running · each capability is a separate consent"
    : `${fmt(onCount)} running · each capability is a separate consent`;
}

/** No consent record to write, so no switch — a dead control is a promise. */
export const CAPABILITY_SWITCH_WITHHELD =
  "No consent record yet — this screen draws no switch";

export function filingStatus(count: number): string {
  return `${fmt(count)} ${count === 1 ? "proposal" : "proposals"} · nothing has been filed`;
}
export function namesStatus(count: number): string {
  return `${fmt(count)} ${count === 1 ? "link" : "links"} · each carries the passage it was read from`;
}

export const ADD_STATUS = "Nothing is uploading";

export function bulkStatus(
  landed: number,
  failed: number,
  total: number
): string {
  return `${fmt(landed)} of ${fmt(total)} landed · ${fmt(failed)} did not · nothing was discarded`;
}

export const SCAN_HANDOFF_BODY =
  "Scan cover: one capture, reviewed here, saved into Docs as an image with its extracted text";
export const SCAN_PDF_WITHHELD =
  "Multi-page capture that lands as one PDF is not built on this phone yet, so this screen does not promise it.";
