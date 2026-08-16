// The four things Docs can do to a document, each asked for on its own
// (Docs spec §10.7 `DCAPS`, §10.8).
//
// THIS WAVE IS THE MODEL ONLY — there is no capabilities screen, no toggle and
// no runner yet, and this file deliberately ships none of them. It exists so
// that every surface which has to say something about a capability (the Coming
// due shelf's "it is switched off" panel, the More sheet's row, the search
// shelf's "what could not be searched" panel) reads the SAME record, and so
// that the day a capability is switched on there is one place that already
// knows what it promised.
//
// "The four capabilities, each consented on its own. A consent that enables
// more than it names is not consent." (spec, prototype line 2354, verbatim.)
//
// Every field below is the spec's own text. Nothing here runs; nothing here
// reads a document. `state` is the answer to "is this on", and the only answer
// this wave can give is `off` — not because the app decided, but because there
// is no consent record to read and inventing one would be the exact failure
// the sentence above names.

export type CapabilityId = "read" | "filing" | "names" | "due";

export interface Capability {
  id: CapabilityId;
  /** The verb, as a member reads it. */
  name: string;
  /** What it would do — one sentence, in the member's terms (§10.7). */
  what: string;
  /** Where it would run. Today every one of them is on-device. */
  where: string;
  /** What leaves the device. `nothing` is the load-bearing word. */
  leaves: string;
  /** What it writes BESIDE the document — never a change to the document. */
  writes: string;
}

/** §10.7's table, verbatim and in the spec's order. */
export const DCAPS: readonly Capability[] = [
  {
    id: "read",
    name: "Read the contents",
    what: "Turn a photographed or scanned document into words, so search can look inside it.",
    where: "on this device",
    leaves: "nothing",
    writes: "a contents column on each document",
  },
  {
    id: "filing",
    name: "Propose a title, a folder and a tag",
    what: "Read a new document and propose where it belongs. It never files anything on its own.",
    where: "on this device",
    leaves: "nothing",
    writes: "a proposal you accept, edit or reject",
  },
  {
    id: "names",
    name: "Find the people a document names",
    what: "Point a document at the people it mentions, carrying the exact passage as its evidence.",
    where: "on this device",
    leaves: "nothing",
    writes: "a link to a People record, with the quoted passage",
  },
  {
    id: "due",
    name: "Find dates that fall due",
    what: "Read expiries, renewals and deadlines out of a document and stage them as tentative appointments.",
    where: "on this device",
    leaves: "nothing",
    writes: "a tentative Agenda event you confirm or drop",
  },
];

/** §10.8's own framing of the whole set, said once. */
export const CAPABILITIES_TITLE =
  "Four things Docs can do, each asked for on its own";
export const CAPABILITIES_BODY =
  "All four are off. Each is a separate consent with its own receipt. None changes a document: each writes something beside it, and that is yours to delete.";

/**
 * Is a capability switched on?
 *
 * There is no consent record for these yet, so the honest answer is `false` for
 * all four — and it is a FUNCTION rather than a constant so that the caller
 * site is already the shape it needs to be when the record exists, instead of
 * a `false` literal scattered through four screens.
 */
export function capabilityOn(_id: CapabilityId): boolean {
  return false;
}

/** The count the More sheet's row and the capabilities screen both print. */
export function capabilitiesOnCount(): number {
  return DCAPS.filter((cap) => capabilityOn(cap.id)).length;
}
