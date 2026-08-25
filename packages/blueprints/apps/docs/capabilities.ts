// The four Docs capabilities, each consented on its own (spec §10.7). Model
// only. `state` is off: there is no consent record, and inventing one is not consent.

export type CapabilityId = "read" | "filing" | "names" | "due";

export interface Capability {
  id: CapabilityId;
  name: string;
  what: string;
  where: string;
  /** What leaves the device. `nothing` is the load-bearing word. */
  leaves: string;
  /** Writes BESIDE the document — never a change to the document. */
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
    // No shelf for this one; the capability stands anyway. Consent still stands on its own.
    id: "due",
    name: "Find dates that fall due",
    what: "Read expiries, renewals and deadlines out of a document and stage them as tentative appointments.",
    where: "on this device",
    leaves: "nothing",
    writes: "a tentative Agenda event you confirm or drop",
  },
];

export const CAPABILITIES_TITLE =
  "Four things Docs can do, each asked for on its own";
export const CAPABILITIES_BODY =
  "All four are off. Each is a separate consent with its own receipt. None changes a document: each writes something beside it, and that is yours to delete.";

/**
 * Always `false` until a consent record exists. A function, not a constant,
 * so caller sites already have the shape they need.
 */
export function capabilityOn(_id: CapabilityId): boolean {
  return false;
}

export function capabilitiesOnCount(): number {
  return DCAPS.filter((cap) => capabilityOn(cap.id)).length;
}
