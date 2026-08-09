import type { InlineScope } from "../inline-types.ts";
// The give/lend destination list every app's share sheet needs (issue #726
// P6, ScopeAppDeclaration's "lendable" contract §D11): ONE list holding both
// the member's own OTHER writable vaults and every LINKED person, with no
// distinction drawn between a co-hosted and a remote peer — locality is
// routing, not semantics (D3). Neither the label nor the order here may hint
// at where a destination physically lives.
//
// TWO VERBS, ONE SUBJECT EACH. A give (`window.centraid.place`) copies a
// FIXED set of items — what is selected right now. A lend
// (`window.centraid.lend`) opens a live window over the CALLER'S WHOLE scope
// for this app's own entity family (`ScopeAppDeclaration.mintedIdFamilies`)
// — not just what happens to be selected. A share sheet that offers both
// verbs must say so in its own copy (see `ShareSheet.tsx`'s lend note):
// selecting three photographs and choosing "Lend" does not lend three
// photographs, it lends the library they came from.
import { mountedScopes } from "./scope-kit.ts";

/** One place a give or a lend could land. Deliberately carries no "kind"
 *  (own vault vs. linked person) — see the file header. */
export interface ShareDestination {
  id: string;
  label: string;
}

/**
 * Every mounted scope this member could copy INTO right now: writable, not
 * the current scope, and not a scope someone else lent them (a read edge
 * lends, it never delegates the right to receive a NEW share into it from
 * here — that destination is reached through its OWN link, listed by
 * `linkedDestinations` below once one exists).
 */
export function ownVaultDestinations(
  scopes: readonly InlineScope[],
  current: string | null | undefined = ""
): ShareDestination[] {
  return scopes
    .filter(
      (scope) => scope.id !== current && scope.canWrite && !scope.borrowed
    )
    .map((scope) => ({ id: scope.id, label: scope.label }));
}

/** A raw `window.centraid.links()` row, before a label is attached. */
export interface LinkRow {
  linkId: string;
  vaultId: string;
  approved: boolean;
}

/**
 * Best-effort human label for a linked vault id. A vault that has already
 * lent something IN carries its own label (the borrowed scope's
 * `holderLabel`); one that has not is a genuine wire gap — this gateway has
 * no route that names a linked-but-never-shared-with vault — so it falls
 * back to a short id rather than inventing a name.
 */
function linkLabel(vaultId: string, scopes: readonly InlineScope[]): string {
  const known = scopes.find((scope) => scope.id === vaultId && scope.borrowed);
  if (known) return known.label;
  return `Linked vault ${vaultId.length > 10 ? `${vaultId.slice(0, 8)}…` : vaultId}`;
}

/** Every APPROVED, non-mounted linked vault — the "linked people" half of
 *  the destination list. Already-mounted destinations (the member's own
 *  vaults) are excluded so nothing appears twice. */
export function linkedDestinations(
  links: readonly LinkRow[],
  scopes: readonly InlineScope[]
): ShareDestination[] {
  const mounted = new Set(scopes.map((scope) => scope.id));
  return links
    .filter((link) => link.approved && !mounted.has(link.vaultId))
    .map((link) => ({
      id: link.vaultId,
      label: linkLabel(link.vaultId, scopes),
    }));
}

/** ONE destination list (D3): own other vaults, then linked people, in the
 *  order the caller supplied them — never re-sorted or grouped by locality. */
export function shareDestinations(
  scopes: readonly InlineScope[],
  currentScopeId: string | null | undefined,
  links: readonly LinkRow[]
): ShareDestination[] {
  const own = ownVaultDestinations(scopes, currentScopeId);
  const people = linkedDestinations(links, scopes);
  return [...own, ...people];
}

/**
 * Load the full destination list live: mounted scopes plus a fresh
 * `window.centraid.links()` call. Never throws — a host with no link plane
 * (or a transient failure) answers the own-vaults half alone, same
 * degrade-to-what-you-have posture the rest of this kit takes.
 */
export async function loadShareDestinations(
  currentScopeId: string | null | undefined,
  scopes: readonly InlineScope[] = mountedScopes()
): Promise<ShareDestination[]> {
  let links: LinkRow[] = [];
  try {
    links = (await window.centraid.links?.()) ?? [];
  } catch {
    links = [];
  }
  return shareDestinations(scopes, currentScopeId, links);
}

/**
 * Why *Share…* cannot even open, or null when it can. Distinct from a
 * per-destination refusal (nowhere to write) — this is "there is nobody to
 * ask at all".
 */
export function shareBlockedReason(
  destinations: readonly ShareDestination[]
): string | null {
  return destinations.length === 0
    ? "There is nowhere to share to yet — no other vault, and nobody linked."
    : null;
}

/** D7's irrevocable warning — a GIVE copies bytes the recipient then owns
 *  outright; nothing this app does afterward can reach back and remove them.
 *  Shown BEFORE a give fires, never after (the invariant this whole sheet
 *  exists to satisfy). */
export const GIVE_IRREVOCABLE_WARNING =
  "Giving makes a copy they own. You can’t take it back — only ask.";

/** D7's lend wording — the ONLY correct verb for closing a live window.
 *  Never "take back": what was already read cannot be un-seen, only the
 *  window itself can close. */
export const STOP_LENDING_LABEL = "Stop lending";

/** The note a share sheet shows once "Lend" is chosen, over items that were
 *  selected for a GIVE — lending has no per-item granularity (see the file
 *  header), so the sheet must say what it actually does before it fires. */
export function lendScopeNote(appLabel: string): string {
  return `Lending shares your whole ${appLabel} library as a live view — not just what’s selected here.`;
}

/** The one live-edge scope declaration this kit's v1 lend offers: the app's
 *  own primary entity family, unfiltered (#726 P6 — a deliberate v1 scoping
 *  decision; per-album/per-item lend scoping is future work, flagged in the
 *  P6 report rather than half-built here). `mintedIdFamilies[0]` is always
 *  `"<schema>.<table>"` (`ScopeAppDeclaration`'s own contract). */
export function wholeLibraryLendScope(
  mintedIdFamilies: readonly string[]
): Array<{ schema: string; table: string }> {
  const [schema, table] = (mintedIdFamilies[0] ?? "").split(".");
  return schema && table ? [{ schema, table }] : [];
}

/**
 * One scope's mask-selection-time reach fact, restated from the gateway's
 * own `ScopeSearchReach` (`packages/gateway/src/serve/lend-search-reach.ts`)
 * without importing it — blueprint apps are unbundled browser ES modules
 * and cannot import from the gateway package (`search-scaffold.ts`'s own
 * "BROWSER ES MODULE, NO BUNDLER" header states the same rule for the
 * query-time reach types). The gateway's `POST /_gateway/edges` response for
 * a live edge carries one of these per lent scope (#726 P4 D10,
 * `edges-routes.ts`'s `edgeWire`).
 */
export interface LendSearchReach {
  schema: string;
  table: string;
  /** `true` when the lent field mask excludes a column the physical table
   *  actually has — search over this scope will not reach everything. */
  masksSearchableColumns: boolean;
}

/**
 * The mask-selection-time half of D10: named the SAME MOMENT a lend is
 * created — the `POST /_gateway/edges` response that opens it — rather than
 * discovered later as thinner-than-expected search results. `null` when
 * every lent scope searches everything it has, which is the ONLY outcome
 * v1's lend can produce today (`wholeLibraryLendScope` never sets a field
 * mask); this stays ready for the per-field lend scoping #726 P6 flagged as
 * future work, so that feature does not also need to invent where its
 * warning surfaces.
 */
export function searchReachWarning(
  reach: readonly LendSearchReach[] | undefined,
  destinationLabel: string
): string | null {
  if (!reach) return null;
  const masked = reach.filter((scope) => scope.masksSearchableColumns);
  if (masked.length === 0) return null;
  const tables = masked.map((scope) => scope.table || scope.schema).join(", ");
  return `${destinationLabel}’s search of this will not reach every column (narrower than the full ${tables} table).`;
}
