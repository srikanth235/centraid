// THE SEAT'S OWN CATCH-UP, ASKED FOR BY A WRITE THAT DID NOT GO THROUGH IT
// (#1011 M2).
//
// Most writes reach the vault through `session.write`, so the seat learns about
// them on the way past. A few do not: the camera-roll Import posts originals to
// the gateway's staged-import route and the gateway commits the rows. Nothing
// on the phone knew, so the owner's own import stayed invisible in their
// library until the next foreground pulled the log — minutes, on the device.
//
// This is a NUDGE, never a poll: one catch-up, asked for once when a batch of
// work is known to have landed on the gateway. A caller that would call it per
// item is asking for a loop and must batch instead.

import type { NativeReplicaSession } from "../../lib/replica/native-session";

/** Just enough of the context to nudge — `useReplica()`'s value satisfies it. */
export interface SeatNudgeTarget {
  session?: Pick<NativeReplicaSession, "pullNow">;
}

/**
 * Pull the seat level now. `false` when there was no session to ask or the
 * catch-up did not land (offline, parked, out of room) — the ordinary ways
 * back (foreground, reachability, the feed) are all still in place, so a
 * refusal here is not an error and is never retried on the spot.
 */
export async function nudgeSeatCatchUp(
  target: SeatNudgeTarget
): Promise<boolean> {
  const session = target.session;
  if (!session) return false;
  return session.pullNow();
}
