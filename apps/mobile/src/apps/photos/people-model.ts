// The People shelf's model (#724). Pure — no React, navigation or theme.
//
// THREE KINDS OF ROW, NEVER MERGED INTO ONE LIST. `people` counts CONFIRMED
// regions only: a named card is an assertion, and only the member's own answer
// may make one. `pendingByParty` is a QUESTION carrying a candidate party id,
// and deliberately has no `name` field so a caller cannot render it as a
// person. `unnamed` is a stranger group keyed by `cluster_id`, with no party.
//
// COUNTS ARE PHOTOGRAPHS, NOT REGIONS: two faces of one person in one
// photograph is one photograph, or the count disagrees with the tiles shown.

import { groupPeopleFaces } from "@centraid/blueprints/apps/_shared/people-counts";
//
// "DETECT FACES" IS GATED ON THE GATEWAY RUNG, NOT THE DEVICE ONE: the sweep
// runs on the gateway. `deviceAnswerFor` answers a different question and
// returns `available: false` for this very tier — a surface offering both must
// ask each helper its own question.
//
// HONEST ABSENCE: nothing here invents a cover, a name, or a count.

export interface FaceRegionRow {
  region_id: string;
  asset_id?: string | null;
  party_id?: string | null;
  confirmed_by_party_id?: string | null;
  review_state?: string | null;
  bbox_json?: unknown;
}

export interface PartyRow {
  party_id: string;
  kind?: string | null;
  display_name?: string | null;
}

export interface FaceClusterRow {
  region_id: string;
  cluster_id: string;
}

/** The app-readable tier mirror. */
export interface EnrichPolicyRow {
  domain?: string | null;
  tier?: string | null;
}

export interface PeopleCover {
  assetId: string;
  regionId: string;
  /** Fractions of the whole photograph; null when unparseable. */
  bbox: { x: number; y: number; w: number; h: number } | null;
}

export interface PersonEntry {
  partyId: string;
  /** "Unnamed" is the VIEW's word: a null here is a fact, a label is a
   *  rendering. */
  name: string | null;
  /** Distinct photographs carrying a CONFIRMED face. */
  count: number;
  cover: PeopleCover | null;
}

export interface PendingEntry {
  /** Proposed AS this party; never resolved to a name here. */
  partyId: string;
  count: number;
  cover: PeopleCover | null;
}

export interface UnnamedGroupEntry {
  clusterId: string;
  count: number;
  /** Every region, so naming the group is one gesture over all of them. */
  regionIds: string[];
  cover: PeopleCover | null;
}

export interface DetectFacesAvailability {
  available: boolean;
  /** Shown in place of the action; absent when available. */
  reason?: string;
}

export interface PeopleShelf {
  people: PersonEntry[];
  pendingByParty: PendingEntry[];
  unnamed: UnnamedGroupEntry[];
  /** The review queue's real size. */
  pendingTotal: number;
  empty: string;
  detectFaces: DetectFacesAvailability;
}

export interface PeopleFacts {
  faces: readonly FaceRegionRow[];
  parties: readonly PartyRow[];
  clusters: readonly FaceClusterRow[];
  policies: readonly EnrichPolicyRow[];
  /** In flight — see `detectFacesFor`. */
  policiesLoading?: boolean;
}

/** One sentence (DESIGN.md `## Copy`). The faces disclosure proper belongs to
 *  the Collections People shelf; a second copy here weakens the promise. */
export const PEOPLE_EMPTY =
  "Face detection runs when you ask for it — the people it finds wait here for you to name.";

export const PEOPLE_PENDING_EMPTY =
  "Face detection is still running on the gateway.";

const DETECT_REASONS = {
  off: "Enrichment is off for photographs — change that in Privacy.",
  device:
    "Photographs are enriched on this device only — allow gateway enrichment in Privacy.",
  unknown: "This library has not said yet how far enrichment may run.",
} as const;

/**
 * The `gateway` rung is the one the faces sweep runs at.
 *
 * COMPAT(enrich-tier-rename #712): `model` is the pre-rename name for
 * `gateway`, and such a row must not read as "not allowed".
 */
export function detectFacesFor(
  tier: string | null | undefined
): DetectFacesAvailability {
  if (tier === "gateway" || tier === "model") return { available: true };
  if (tier === "device" || tier === "local")
    return { available: false, reason: DETECT_REASONS.device };
  if (tier === "off") return { available: false, reason: DETECT_REASONS.off };
  // `null` is "not read yet", not a refusal: nothing true to say yet.
  if (tier == null) return { available: false };
  return { available: false, reason: DETECT_REASONS.unknown };
}

function parseBbox(json: unknown): PeopleCover["bbox"] {
  if (typeof json !== "string") return null;
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null) return null;
  const box = parsed as Record<string, unknown>;
  const values = ["x", "y", "w", "h"].map((key) => box[key]);
  if (values.some((value) => typeof value !== "number")) return null;
  const [x, y, w, h] = values as number[];
  return { x: x as number, y: y as number, w: w as number, h: h as number };
}

/** The EARLIEST region id with a photograph behind it: region ids sort stably,
 *  so a cover does not shuffle between loads. */
function coverOf(regions: readonly FaceRegionRow[]): PeopleCover | null {
  const usable = regions
    .filter((region) => Boolean(region.asset_id))
    .sort((a, b) => (a.region_id < b.region_id ? -1 : 1));
  const chosen = usable[0];
  if (!chosen) return null;
  return {
    assetId: String(chosen.asset_id),
    regionId: chosen.region_id,
    bbox: parseBbox(chosen.bbox_json),
  };
}

/** Deterministic ordering throughout, so one library renders one shelf. */
export function buildPeopleShelf(facts: PeopleFacts): PeopleShelf {
  const nameOf = new Map(
    facts.parties
      .filter((party) => party.kind === "person" || party.kind == null)
      .map((party) => [party.party_id, party.display_name ?? null] as const)
  );

  const grouped = groupPeopleFaces(facts.faces, facts.clusters);
  const faceById = new Map(facts.faces.map((face) => [face.region_id, face]));

  const people: PersonEntry[] = [...grouped.confirmed]
    .map((group) => ({
      partyId: group.id,
      name: nameOf.get(group.id) ?? null,
      count: group.assetIds.length,
      cover: coverOf(
        group.regionIds.flatMap((regionId) => {
          const region = faceById.get(regionId);
          return region ? [region] : [];
        })
      ),
    }))
    .sort((a, b) => {
      // Named first, then by name, then by id — a stable rendering order.
      if ((a.name === null) !== (b.name === null))
        return a.name === null ? 1 : -1;
      if (a.name !== null && b.name !== null && a.name !== b.name)
        return a.name < b.name ? -1 : 1;
      return a.partyId < b.partyId ? -1 : 1;
    });

  const pendingByParty: PendingEntry[] = [...grouped.pendingByParty]
    .map((group) => ({
      partyId: group.id,
      count: group.assetIds.length,
      cover: coverOf(
        group.regionIds.flatMap((regionId) => {
          const region = faceById.get(regionId);
          return region ? [region] : [];
        })
      ),
    }))
    .sort((a, b) =>
      a.count === b.count ? (a.partyId < b.partyId ? -1 : 1) : b.count - a.count
    );

  // Intersected with the regions this read carries: a cluster whose region is
  // absent contributes nothing, rather than a card the member cannot open.
  const unnamed: UnnamedGroupEntry[] = grouped.unnamed
    .map((group) => ({
      clusterId: group.id,
      count: group.assetIds.length,
      regionIds: group.regionIds,
      cover: coverOf(
        group.regionIds.flatMap((regionId) => {
          const region = faceById.get(regionId);
          return region ? [region] : [];
        })
      ),
    }))
    .sort((a, b) =>
      a.count === b.count
        ? a.clusterId < b.clusterId
          ? -1
          : 1
        : b.count - a.count
    );

  const tier = facts.policiesLoading
    ? null
    : (facts.policies.find((row) => row.domain === "photos")?.tier ?? "off");

  return {
    people,
    pendingByParty,
    unnamed,
    pendingTotal: grouped.pendingTotal,
    // A member who already asked is owed "it has not finished", not a second
    // invitation to ask.
    empty: facts.faces.length > 0 ? PEOPLE_PENDING_EMPTY : PEOPLE_EMPTY,
    detectFaces: detectFacesFor(tier),
  };
}

export interface DetectFacesIntent {
  action: "request-enrichment";
  input: { entity_type: "media.asset" };
}

/** `reason` and `capability` are pinned SERVER-side by the blueprint action,
 *  so a client cannot widen its own consent by editing an input. */
export function detectFacesIntent(): DetectFacesIntent {
  return {
    action: "request-enrichment",
    input: { entity_type: "media.asset" },
  };
}

export interface NameFaceIntent {
  action: "answer-face";
  input: { region_id: string; answer: "confirm"; party_id: string };
}

/**
 * One confirm per region, deliberately NOT one command: the member asserts a
 * fact about each face, and a batch verb would record an assertion about a face
 * they never saw. Batching belongs here, in the surface that showed the group.
 */
export function nameGroupIntents(
  group: Pick<UnnamedGroupEntry, "regionIds">,
  partyId: string
): NameFaceIntent[] {
  return group.regionIds.map((regionId) => ({
    action: "answer-face",
    input: { region_id: regionId, answer: "confirm", party_id: partyId },
  }));
}
