// The phone's own status sentences (#821). Sentences the SHARED copy modules
// carry are imported at their call sites, never restated here.

const fmt = (n: number): string => n.toLocaleString("en-US");

export function allStatus(count: number): string {
  return `${fmt(count)} · press and hold a row for quick actions`;
}

export function foldersStatus(count: number): string {
  return `${fmt(count)} ${count === 1 ? "folder" : "folders"} · a folder is a label, not a place`;
}

export function trashStatus(count: number): string {
  return `${fmt(count)} in trash · each purged 30 days after it was deleted`;
}

/** Photograph count WITHHELD: Docs' replica scope reads document tags only. */
export function starredStatus(count: number): string {
  return `${fmt(count)} starred`;
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

/** The `due` capability is off with no runner: state the absence, never guess. */
export const DUE_EMPTY_TITLE = "Nothing has been read";
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
