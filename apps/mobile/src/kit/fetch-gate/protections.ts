// WHO ANSWERS "THIS ONE MAY NOT GO" (#996 R7/R25).
//
// `ContentProtections` was left a seam by wave 2 on purpose: whether a queued
// intent still needs a content id is the OUTBOX's fact, and the byte store
// must not guess it from its own filenames. A seam with no supplier, though,
// is a protection that reads `false` in production and `true` only in the test
// that passes it by hand — which is what this file exists to stop.
//
// A REGISTRY, NOT AN IMPORT. `download.ts` cannot import the replica session:
// the session imports the fetch gate to hand bytes to a write, so the reverse
// edge would close a cycle. The session registers its answer when it opens and
// withdraws it when it closes, and an unregistered store protects pins and
// nothing else — the behaviour before the policy landed, stated rather than
// stumbled into.

import type { ContentProtections } from "./content-store";
import type { ContentRef } from "./pin";

let registered: ContentProtections = {};

/**
 * Install the answers. The LAST caller wins because there is one open seat
 * (R12): two sessions racing to protect one cache would be the mount plane
 * back under another name.
 */
export function setContentProtections(protections: ContentProtections): void {
  registered = protections;
}

/** A closing session takes its answer with it: a stale predicate over a dead
 *  outbox would pin bytes nothing needs, forever. */
export function clearContentProtections(): void {
  registered = {};
}

export function contentProtections(): ContentProtections {
  return registered;
}

/** True when the eviction rule would refuse this ref for a reason beyond a pin. */
export function protectedByPendingWork(ref: ContentRef): boolean {
  return (
    registered.capturedHere?.(ref) === true ||
    registered.referencedByPendingIntent?.(ref) === true
  );
}
