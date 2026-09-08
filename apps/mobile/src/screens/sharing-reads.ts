// The Sharing screen's read plane, kept out of `Sharing.tsx` so that file
// stays under the repo's file-size guidance — and so the two rules this half
// exists to keep are provable without mounting a screen.
//
//  1. L-READ (#821): every share read degrades to ABSENT, never empty. "No
//     people linked yet." may only ever be drawn from an answer; rendering it
//     from a read that failed states a fact this device never learned.
//  2. REFUSED IS NOT UNREACHABLE (docs/mobile-offline.md): a request that
//     never left the device and a gateway that answered no are different
//     screens, and collapsing them makes "you are offline" read as a refusal.

export type ShareReadReach = "unreachable" | "refused";

/** One section's answer. THREE states, because `absent` is not `read` with no
 *  rows and neither is "we have not asked yet" — an empty list drawn before
 *  the first answer lands is the same lie, told earlier. */
export type ShareRead<T> =
  | { state: "loading" }
  | { state: "read"; rows: readonly T[] }
  | { state: "absent"; reach: ShareReadReach };

export const SHARE_READ_LOADING: ShareRead<never> = { state: "loading" };

/** `fetch` rejects with a TypeError when the request never left the device, and
 *  a replica that already knows it is offline is the same fact. Anything else
 *  reached the gateway and came back with an answer. */
export function shareReadReach(
  error: unknown,
  online: boolean
): ShareReadReach {
  return !online || error instanceof TypeError ? "unreachable" : "refused";
}

/** Absence, named. Never "none" — that is a different fact (L-read). */
export function shareAbsentLine(noun: string, reach: ShareReadReach): string {
  return reach === "unreachable"
    ? `${noun} could not be read — the gateway is out of reach.`
    : `${noun} could not be read — the gateway refused this read.`;
}

export async function readShareSection<T>(
  read: () => Promise<readonly T[]>,
  online: boolean
): Promise<ShareRead<T>> {
  try {
    return { state: "read", rows: await read() };
  } catch (error) {
    return { state: "absent", reach: shareReadReach(error, online) };
  }
}
