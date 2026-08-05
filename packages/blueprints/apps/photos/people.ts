// The People shelf's own data (v4 handoff §5), page-side.
//
// PEOPLE STAY OWN-SCOPE, for the same reason albums, places and trash do
// (app-root.tsx's header): a party id minted in one scope means nothing in
// another — or, worse, means someone else, since ids collide across scopes by
// design. "Who is in my library" is therefore a question about the member's
// own library, asked with the plain `read` door rather than the multi-scope
// fan-out.
//
// LOADED LAZILY, like the duplicates shelf: the roster walks every confirmed
// face region, which is a bigger read than the bounded timeline window, so it
// runs when the member opens the shelf and not on every refresh.
import type { Asset } from "./types.ts";

/** One confirmed person, as the shelf shows them. */
export interface Person {
  party_id: string;
  /** The confirmed display name, or null where the party has none. */
  name: string | null;
  /** How many photographs carry them — an exact count, never an estimate. */
  count: number;
  /** Which ones, so the person's own timeline needs no second read. */
  asset_ids: string[];
}

/** One unconfirmed face proposal, as the shelf shows it (issue #711 review).
 *  Deliberately has NO `name` field — see `queries/people.ts`'s header for
 *  why a proposal is never resolved to a name, even when `party_id` points
 *  at someone already confirmed elsewhere. */
export interface FaceProposal {
  cluster_id: string;
  /** The enricher's candidate, if it offered one — a linkage, not a name. */
  party_id: string | null;
  /** Distinct photographs behind this proposal — exact, never estimated. */
  count: number;
  /** The region Face Review should open to when this card is the way in. */
  region_id: string;
  cover: {
    asset_id: string;
    content_uri: string | null;
    thumb_uri: string | null;
    width: number | null;
    height: number | null;
    bbox: { x: number; y: number; w: number; h: number } | null;
  } | null;
}

interface PeopleData {
  people?: Person[];
  proposals?: FaceProposal[];
  unmatchedTotal?: number;
  vaultDenied?: { code?: string; message?: string } | null;
  error?: string;
}

export interface PeopleStore {
  /** Load once. A no-op while loaded or in flight. */
  ensureLoaded: () => Promise<void>;
  /** Everything confirmed, most photographs first. `null` = not loaded yet. */
  list: () => Person[] | null;
  /** Every unconfirmed proposal the shelf has a cover for. `null` = not
   *  loaded yet, same contract as `list()`. */
  proposalList: () => FaceProposal[] | null;
  /** The vault-wide unmatched face count (same fact `queries/face-queue.ts`
   *  derives) — `null` while unread, so a caller can omit the number rather
   *  than claim a zero nobody checked. */
  unmatchedTotal: () => number | null;
  /** One person by party id, or undefined when the roster has never named
   *  them (a person confirmed on another device, before the next load). */
  find: (partyId: string) => Person | undefined;
  /** The photographs confirmed as one person, out of what is loaded. */
  assetsFor: (partyId: string, assets: readonly Asset[]) => Asset[];
  /** Force the next visit to re-read — a confirm/reject elsewhere invalidates
   *  the roster the same way a trash invalidates the duplicate clusters. */
  invalidate: () => void;
}

export function createPeople({ onData }: { onData: () => void }): PeopleStore {
  let people: Person[] | null = null;
  let proposals: FaceProposal[] | null = null;
  let unmatched: number | null = null;
  let loading = false;

  async function ensureLoaded(): Promise<void> {
    if (people != null || loading) return;
    loading = true;
    let data: PeopleData | undefined;
    try {
      data = await window.centraid.read<PeopleData>({
        query: "people",
        input: {},
      });
    } catch {
      data = undefined;
    }
    // A failed read leaves an EMPTY roster rather than a permanent skeleton:
    // the shelf's empty copy says a name is only ever the member's to confirm,
    // which is true either way, and the next visit re-reads.
    people = [...(data?.people ?? [])].sort((a, b) => b.count - a.count);
    proposals = [...(data?.proposals ?? [])];
    // A failed read leaves the count unread (`null`), not a false zero — the
    // same "omit rather than claim a zero nobody checked" rule the note
    // itself follows (view-copy.ts's `peoplePendingNote`).
    unmatched = data?.unmatchedTotal ?? null;
    loading = false;
    onData();
  }

  function assetsFor(partyId: string, assets: readonly Asset[]): Asset[] {
    // `new Set(undefined)` is an empty set, so an unknown person filters to
    // nothing rather than needing a second branch.
    const wanted = new Set(find(partyId)?.asset_ids);
    return assets.filter((asset) => wanted.has(asset.asset_id));
  }

  function find(partyId: string): Person | undefined {
    return (people ?? []).find((person) => person.party_id === partyId);
  }

  return {
    ensureLoaded,
    list: () => people,
    proposalList: () => proposals,
    unmatchedTotal: () => unmatched,
    find,
    assetsFor,
    invalidate: () => {
      people = null;
      proposals = null;
      unmatched = null;
    },
  };
}
