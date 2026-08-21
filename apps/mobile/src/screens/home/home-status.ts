// What Home's ambient status line SAYS (the Binding Layer, invariant 5).
//
// Split from ./HomeStatusLine for the same reason ./tile-model is split from
// ./TileBody: the sentence is the part that can be dishonest, so it is the part
// under test, and a pure module needs no renderer to assert it.
//
// Three rules, and every one of them is about not claiming more than is known:
//
//  · While a read is in flight the line says it is still counting rather than
//    publishing a number that is about to change under the reader.
//  · When a contributing read hit its row ceiling the total is a FLOOR, and the
//    line says "at least" — a capped count rendered bare is a lie with a comma
//    in it.
//  · A fact this device does not hold is stated as absent, never invented. The
//    desktop line carries a last-backup time; backup runs on the gateway and the
//    phone has no read for it, so this says where the answer lives instead of
//    guessing a date.

export interface HomeStatusFacts {
  /** Sum of every count a read actually returned (./tile-model#countThings). */
  total: number;
  /** True when any contributing read hit its ceiling — the total is a floor. */
  capped: boolean;
  /** False while any tile read is still in flight. */
  settled: boolean;
  /** The gateway's host label, when this phone is joined to one. */
  gatewayName: string | undefined;
  /** True when the gateway is not answering. */
  offline: boolean;
}

/** Grouped, because "8432" and "8,432" are not equally readable at 11.5px. */
const count = (n: number): string => n.toLocaleString();

function thingsClause(facts: HomeStatusFacts): string {
  if (!facts.settled) return "Counting what is in this vault…";
  const noun = facts.total === 1 && !facts.capped ? "thing" : "things";
  const lead = facts.capped ? "At least " : "";
  return `${lead}${count(facts.total)} ${noun} in this vault.`;
}

/** Home's one line about the vault, with no invented facts in it. */
export function statusSentence(facts: HomeStatusFacts): string {
  const things = thingsClause(facts);
  if (!facts.gatewayName)
    return `${things} No gateway is paired with this phone.`;
  if (facts.offline)
    // OFFLINE IS NOT A FAULT REPORT. The predecessor led with a failure
    // ("is not answering") and followed with reassurance. That is backwards
    // for an offline-first product: the local replica holding everything is
    // the PROMISE, not the consolation prize, and nobody using a photo library
    // on a plane thinks their phone is broken. State the one thing that is
    // different — writes land later — as a schedule, not a denial.
    return `${things} Offline — changes sync when ${facts.gatewayName} is back.`;
  return `${things} Backups run on ${facts.gatewayName}.`;
}
