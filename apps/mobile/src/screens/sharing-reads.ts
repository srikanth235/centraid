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
//
// Reads span every MOUNTED scope rather than the focused vault alone: pairing
// can grant several vaults and up to four are mounted, so an invitation or a
// dead-steward recovery on a non-focused vault would otherwise stay invisible
// until the member happened to re-focus that vault.

export type ShareReadReach = "unreachable" | "refused";

/** One section's answer. THREE states, because `absent` is not `read` with no
 *  rows and neither is "we have not asked yet" — an empty list drawn before
 *  the first answer lands is the same lie, told earlier. */
export type ShareRead<T> =
  | { state: "loading" }
  | { state: "read"; rows: readonly T[] }
  | { state: "absent"; reach: ShareReadReach };

export const SHARE_READ_LOADING: ShareRead<never> = { state: "loading" };

/** Which mounted vault a row came from, stamped on at read time — a row's own
 *  payload names vault ids, never the label the member gave the vault. */
export interface ShareRowSource {
  sourceVaultId: string;
  sourceLabel: string;
}

export interface ShareScope {
  vaultId: string;
  label: string;
}

/** Rows from the scopes that answered, plus the labels of those that did not.
 *  A partial answer stays partial: the rows that landed never stand in for the
 *  whole set. */
export interface ScopedShareRead<T> {
  rows: readonly T[];
  missed: readonly string[];
  /** Present only when at least one scope failed. */
  reach?: ShareReadReach;
}

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

/** Some vaults answered and some did not; the rows that landed may not imply
 *  the rest. */
export function sharePartialLine(missed: readonly string[]): string {
  return `Not everything is shown — ${missed.join(", ")} could not be read.`;
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

interface ScopeAnswer<T> {
  scope: ShareScope;
  rows?: readonly T[];
  reach?: ShareReadReach;
}

/** Every mounted scope is asked, and one scope's refusal never silences the
 *  rest — a household with four vaults mounted would otherwise lose three
 *  answers to one unreachable one. */
export async function readShareScopes<T extends object>(
  scopes: readonly ShareScope[],
  read: (vaultId: string) => Promise<readonly T[]>,
  online: boolean
): Promise<ScopedShareRead<T & ShareRowSource>> {
  const answers: ScopeAnswer<T>[] = await Promise.all(
    scopes.map(async (scope) => {
      try {
        return { scope, rows: await read(scope.vaultId) };
      } catch (error) {
        return { scope, reach: shareReadReach(error, online) };
      }
    })
  );
  const missed = answers.filter((answer) => answer.reach !== undefined);
  return {
    rows: answers.flatMap((answer) =>
      (answer.rows ?? []).map((row) => ({
        ...row,
        sourceVaultId: answer.scope.vaultId,
        sourceLabel: answer.scope.label,
      }))
    ),
    missed: missed.map((answer) => answer.scope.label),
    // The first failure's reason speaks for the set: two vaults on one gateway
    // fail the same way, and inventing a combined verdict would say more than
    // was observed.
    ...(missed[0]?.reach ? { reach: missed[0].reach } : {}),
  };
}
