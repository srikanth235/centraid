// THE BYTES THE MEMBER'S OWN QUEUE STILL NEEDS (#996 R25).
//
// The eviction rule already refuses to touch bytes a queued intent needs
// (`kit/fetch-gate/eviction.ts`). What it had no way to KNOW was which those
// are: the predicate was a seam nobody supplied, so in production every answer
// was `false` and a capture whose write had not settled was as evictable as a
// thumbnail someone scrolled past a year ago. Losing it makes the member's own
// queued work unsendable from the one device that has the bytes.
//
// THE OUTBOX IS THE ONLY HONEST SOURCE. An intent's input NAMES the rows it is
// about (`namedRowIds`, the same reading the chain derives its edges from), so
// the ids a pending intent names are the content this queue is still working
// on. Nothing is inferred from a filename, a directory or the shape of a
// string, and an id stops being protected the moment its intent settles.
//
// THE SET IS A SNAPSHOT, AND IT HAS TO BE. `planContentEviction` runs inside a
// synchronous file sweep; the outbox is an async store. So the session pushes
// the ids here whenever its queue moves, and the sweep reads the last push.
// The failure mode of a stale snapshot is one pass that protects a byte it no
// longer needs to — never one that evicts a byte it does.
//
// AND THERE IS ONE SET PER VAULT, NOT ONE PER PHONE (#1014, C7). This was a
// module-global: every session's publish OVERWROTE the previous one and one
// session closing cleared them all. A phone with Personal and Family both
// mounted — the arrangement R25 was actually found in — made vault A's
// captured-but-unsent photograph evictable the moment vault B's queue moved.
// The eviction rule asks about a content id, and a content id is protected if
// ANY mounted vault's queue still needs it, so the answer is the union.

import { namedRowIds } from "@centraid/client/replica/native";
import type { ReplicaIntent } from "@centraid/client/replica/native";

import {
  clearContentProtections,
  setContentProtections,
} from "../../kit/fetch-gate/protections";

/** States whose intent still has work to do; a settled one holds nothing. */
const UNSETTLED = new Set([
  "queued",
  "sending",
  "parked",
  "awaiting-change",
  "conflict",
  "conflict-base-missing",
  "failed",
]);

/** Per vault, so one seat's queue never speaks for another's (#1014, C7). */
const referenced = new Map<string, ReadonlySet<string>>();

function referencedByAnyVault(contentId: string): boolean {
  for (const held of referenced.values()) if (held.has(contentId)) return true;
  return false;
}

/** Every row id the unsettled outbox names, deduplicated. */
export function contentRefsPendingIntentsNeed(
  intents: readonly ReplicaIntent[]
): Set<string> {
  const ids = new Set<string>();
  for (const intent of intents) {
    if (!UNSETTLED.has(intent.state)) continue;
    for (const id of namedRowIds(intent.input)) ids.add(id);
  }
  return ids;
}

/**
 * Publish this seat's answer to the byte store.
 *
 * Registered once per open session and refreshed on every outbox move, so the
 * protection is a fact about the live queue rather than a snapshot taken at
 * open and then trusted for the life of the process.
 */
export function publishPendingContentRefs(
  vaultId: string,
  intents: readonly ReplicaIntent[]
): void {
  referenced.set(vaultId, contentRefsPendingIntentsNeed(intents));
  // Re-registered rather than registered once, because the registry's rule is
  // "the last caller wins" and something else may have installed its own
  // answers since. The predicate reads the live map, so a vault that publishes
  // after this call is already covered by it.
  setContentProtections({
    referencedByPendingIntent: (ref) => referencedByAnyVault(ref.contentId),
  });
}

/**
 * THIS seat is closing: its queue is no longer a reason to keep anything.
 *
 * The other mounted vaults' queues still are, so the registry is withdrawn
 * only once the last of them has gone.
 */
export function forgetPendingContentRefs(vaultId: string): void {
  referenced.delete(vaultId);
  if (referenced.size === 0) clearContentProtections();
}
