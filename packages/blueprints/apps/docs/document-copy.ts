// What ONE DOCUMENT's own screens say (Docs spec §6.1, §6.2, §6.3, §8): the
// seven write outcomes, the reading view's rows, the version screen's fold,
// and the details rail's tabs and notes.
//
// The third copy module, split from `view-copy.ts` on the same axis the app is
// split on: a shelf is a set of rows, and these screens are about one row.
// Nothing here knows what a shelf is.

// ---------------------------------------------------------------------------
// The seven write outcomes (§6.3 `DSAVE`)
// ---------------------------------------------------------------------------

/**
 * "A write has SEVEN visible outcomes. The editor is where all seven land, and
 * knowing which one you are in is the whole design problem there."
 * (§6.3, prototype line 2330, verbatim.)
 *
 * The table is here rather than in the editor for the reason every other table
 * in this file is: seven outcomes expressed as conditions inside a save
 * handler is seven chances for two of them to read as one. `commit` is the
 * LABEL only — whether the control may be pressed is `commits`, and a control
 * that may not be pressed is not filled ("A filled control that cannot be
 * pressed stops being filled", §6.3, verbatim).
 */
export type SaveOutcomeId =
  | "unsaved"
  | "saving"
  | "saved"
  | "nochange"
  | "approval"
  | "queued"
  | "refused";

export interface SaveOutcome {
  id: SaveOutcomeId;
  label: string;
  /** The state row's sentence. */
  status: string;
  /** The paragraph under it — never longer than 56ch on screen. */
  note: string;
  /** The commit button's label. */
  commit: string;
  /** May the commit be pressed — and therefore be filled — in this state? */
  commits: boolean;
  /** The `net` role: a refusal, or a write that is not going anywhere yet. */
  net: boolean;
  /** The inline text action beside the state sentence, where there is one. */
  action?: string;
}

export const DSAVE: Readonly<Record<SaveOutcomeId, SaveOutcome>> = {
  unsaved: {
    id: "unsaved",
    label: "unsaved changes",
    status: "Unsaved changes on this device · nothing has been committed",
    note: "Closing now keeps the draft here and commits nothing. The document in the library is unchanged.",
    commit: "Save",
    commits: true,
    net: false,
  },
  saving: {
    id: "saving",
    label: "saving",
    status: "Saving · one command in flight",
    note: "The command has left this device and has not been acknowledged. Nothing else is queued behind it.",
    commit: "Saving…",
    commits: false,
    net: false,
  },
  saved: {
    id: "saved",
    label: "saved",
    status: "Saved",
    note: "Committed as a new version. The receipt is in this document's history, and version 6 is still there in full.",
    commit: "Saved",
    commits: false,
    net: false,
    action: "Open the receipt",
  },
  nochange: {
    id: "nochange",
    label: "nothing changed",
    status: "Nothing changed · no new version, no receipt",
    note: "The body you saved is byte-identical to version 7. A no-op is not a version: nothing was written, and the history is not one entry longer.",
    commit: "Save",
    commits: true,
    net: false,
  },
  approval: {
    id: "approval",
    label: "waiting for approval",
    status: "Waiting for the owner's approval · held, not refused",
    note: "The write is legitimate and it is being held until the owner consents. It is in Notifications, and it commits the moment they do. This is not the same state as queued.",
    commit: "Save",
    commits: false,
    net: false,
    action: "Show it in Notifications",
  },
  queued: {
    id: "queued",
    label: "queued on this device",
    status: "Queued on this device · the gateway is unreachable",
    note: "The write is legitimate and nobody has to approve it. It is on this device, in order, and it goes the moment the gateway is back. Nothing is lost and nothing is discarded to make room.",
    commit: "Save",
    commits: false,
    net: true,
  },
  refused: {
    id: "refused",
    label: "refused",
    status: "Refused",
    note: 'The rule that refused it can be named: a body can only be set on a text document. This is a different refusal from "not permitted", which names a person to ask instead of a rule.',
    commit: "Save",
    commits: true,
    net: true,
  },
};

/**
 * The `saved` state's status line carries LIVE numbers — "Saved · version 7 ·
 * 14:02" in the spec is that sample drive's version and clock. A caller that
 * knows neither prints neither rather than a number it invented.
 */
export function savedStatus({
  version,
  at,
}: { version?: number | null; at?: string | null } = {}): string {
  const parts = ["Saved"];
  if (typeof version === "number") parts.push(`version ${version}`);
  if (at) parts.push(at);
  return parts.join(" · ");
}

/** The `refused` state names the RULE. The vault hands back its own reason;
 *  where it does not, the spec's own sentence stands. */
export function refusedStatus(reason?: string | null): string {
  return `Refused · ${reason?.trim() || "this document is not text"}`;
}

// ---------------------------------------------------------------------------
// The reading view (§6.1)
// ---------------------------------------------------------------------------

/** The eyebrow over the machine summary — said EVERY time, because the whole
 *  point of the box is that a member never mistakes it for their own words. */
export const MACHINE_SUMMARY_EYEBROW = "Read by a machine, not written by you";

/** §6.1's panel for a document opened while the read capability is off. */
export const READ_OFF = {
  eyebrow: "Switched off",
  title: "Three capabilities are switched off",
  body: "A summary, the people this document names and the dates it contains each need a capability you have not turned on. Stated once, here.",
  action: "What Docs may read →",
} as const;

/** §6.1's "This document" rows, in the spec's order and words. `sub` for the
 *  two rows that carry a live number is supplied by the caller. */
export const THIS_DOCUMENT = {
  head: "This document",
  edit: {
    label: "Edit",
    sub: "title and body, in place. Every save is a version",
    action: "Edit",
  },
  versions: {
    label: "Version history",
    sub: "preview and restore any of them",
    action: "History",
  },
  names: {
    label: "Who this document names",
    subOff: "switched off",
    note: "Docs has not looked. One consent, running on this device",
    action: "Open",
  },
  details: {
    label: "Details",
    sub: "filing, purge date, size, backup and custody",
    action: "Details",
  },
} as const;

// ---------------------------------------------------------------------------
// Versions (§6.2) and the details rail (§8)
// ---------------------------------------------------------------------------

/** §6.2 folds Activity INTO the version history, and says so. */
export const VERSIONS_ACTIVITY_HEAD = "Activity";
export const VERSIONS_ACTIVITY_META = "folded in here, deliberately";
export const VERSIONS_CUT_NOTE =
  "Cut: Activity as its own screen. What happened to a document and which version it produced are one spine. The third column records whether a member, an app or a machine did it.";

/** §8's three tabs. One rail answers all three former screens: "All three
 *  answer 'what is this row', so they belong beside the row and not three
 *  screens away from it." (§8, verbatim.) */
export const RAIL_TABS = [
  { id: "props", label: "Properties" },
  { id: "facts", label: "Facts" },
  { id: "names", label: "Names" },
] as const;

export type RailTabId = (typeof RAIL_TABS)[number]["id"];

/** The notes §8 hangs off individual rows — each one a RULE, so each one is
 *  the spec's own sentence rather than a paraphrase. */
export const RAIL_NOTES = {
  folder: "a label on the document, not a place it sits",
  owner: "this document is in your own space",
  namesOff: "Docs has not looked. One consent, running on this device",
  cannotRender:
    "nothing has been converted. Docs holds it, versions it and files it, and hands the file to an app that reads this kind",
  duplicateBytes:
    "One copy of the bytes, and every app that points at it points at the same copy.",
  footer:
    "Everything here is about one row. Select another and the rail follows it.",
} as const;

/** §8's trailing row for a kind Docs cannot show (§10.1's `render` column). */
export function cannotRenderFact(kindName: string): string {
  return `Docs cannot render ${kindName}`;
}
