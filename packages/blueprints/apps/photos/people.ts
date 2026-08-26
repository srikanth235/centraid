// PEOPLE STAY OWN-SCOPE: a party id minted in another scope means nothing, or
// means someone else. Loaded lazily — the roster walks every face region.
import type { Asset } from "./types.ts";

export interface Person {
  party_id: string;
  name: string | null;
  count: number;
  asset_ids: string[];
  /** Distinct confirmers (#712 P6b) — never merged. */
  confirmed_by?: Array<{ party_id: string; name: string | null }>;
}

/** NO `name` field, by design: a proposal is never resolved to a name (#711). */
export interface FaceProposal {
  cluster_id: string;
  party_id: string | null;
  count: number;
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
  ensureLoaded: () => Promise<void>;
  list: () => Person[] | null;
  proposalList: () => FaceProposal[] | null;
  unmatchedTotal: () => number | null;
  find: (partyId: string) => Person | undefined;
  assetsFor: (partyId: string, assets: readonly Asset[]) => Asset[];
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
    people = [...(data?.people ?? [])].sort((a, b) => b.count - a.count);
    proposals = [...(data?.proposals ?? [])];
    // Unread stays `null`, never a false zero.
    unmatched = data?.unmatchedTotal ?? null;
    loading = false;
    onData();
  }

  function assetsFor(partyId: string, assets: readonly Asset[]): Asset[] {
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
