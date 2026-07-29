// The vocabulary of a member's spaces (issue #599, Decision 14) — the shape the
// scope registry produces and the words the UI spells a role with.
//
// Kept apart from `useMemberScopes.ts` because that module reaches the gateway
// client (which binds `window.CentraidApi` at import time); a screen that only
// needs to SAY "Owner" should not have to stand up a host bridge to do it.

/** One space the calling member holds a role in. */
export interface MemberScope {
  id: string;
  label: string;
  color?: string;
  icon?: string;
  /** `admin` | `write` | `read` as the gateway spells it. */
  role: string;
  /** Whether this member may write here — admin is write's superset. */
  canWrite: boolean;
}

/** Ownership words for a role — the badge on a space card or picker row.
 *  Deliberately not the wire word: a member reads "Owner", not "admin". */
export function roleBadge(role: string): string {
  if (role === "admin") return "Owner";
  if (role === "write") return "Member";
  return "Viewer";
}

/** One sentence of what the role lets this member do. */
export function roleSentence(role: string): string {
  if (role === "admin") return "You own this space and can share it.";
  if (role === "write") return "You can add and change things here.";
  return "You can read this space, not change it.";
}

/** Whether a role may write — admin is write's superset. */
export function canWrite(role: string): boolean {
  return role === "admin" || role === "write";
}

/**
 * Whether this member owns any space on this installation, i.e. may act on
 * OTHER people's household rows (revoke their devices, remove them, mint
 * tickets). A viewer used to be shown those buttons and every click silently
 * no-op'd against the gateway's refusal (onboarding run B11), so the roster
 * reads the same scope registry the "Viewer · <space>" copy reads.
 */
export function canAdministerHousehold(
  spaces: readonly MemberScope[]
): boolean {
  return spaces.some((space) => space.role === "admin");
}
