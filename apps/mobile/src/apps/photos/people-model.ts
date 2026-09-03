import { groupPeopleFaces } from "@centraid/blueprints/apps/_shared/people-counts";

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

export interface EnrichPolicyRow {
  domain?: string | null;
  tier?: string | null;
}

export interface PeopleCover {
  assetId: string;
  regionId: string;
  bbox: { x: number; y: number; w: number; h: number } | null;
}

export interface PersonEntry {
  partyId: string;
  name: string | null;
  count: number;
  cover: PeopleCover | null;
}

export interface PendingEntry {
  partyId: string;
  count: number;
  cover: PeopleCover | null;
}

export interface UnnamedGroupEntry {
  clusterId: string;
  count: number;
  regionIds: string[];
  cover: PeopleCover | null;
}

export interface DetectFacesAvailability {
  available: boolean;
  reason?: string;
}

export interface PeopleShelf {
  people: PersonEntry[];
  pendingByParty: PendingEntry[];
  unnamed: UnnamedGroupEntry[];
  pendingTotal: number;
  empty: string;
  detectFaces: DetectFacesAvailability;
}

export interface PeopleFacts {
  faces: readonly FaceRegionRow[];
  parties: readonly PartyRow[];
  clusters: readonly FaceClusterRow[];
  policies: readonly EnrichPolicyRow[];
  policiesLoading?: boolean;
}

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

export function detectFacesFor(
  tier: string | null | undefined
): DetectFacesAvailability {
  if (tier === "gateway" || tier === "model") return { available: true };
  if (tier === "device" || tier === "local")
    return { available: false, reason: DETECT_REASONS.device };
  if (tier === "off") return { available: false, reason: DETECT_REASONS.off };
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
    empty: facts.faces.length > 0 ? PEOPLE_PENDING_EMPTY : PEOPLE_EMPTY,
    detectFaces: detectFacesFor(tier),
  };
}

export interface DetectFacesIntent {
  action: "request-enrichment";
  input: { entity_type: "media.asset" };
}

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

export function nameGroupIntents(
  group: Pick<UnnamedGroupEntry, "regionIds">,
  partyId: string
): NameFaceIntent[] {
  return group.regionIds.map((regionId) => ({
    action: "answer-face",
    input: { region_id: regionId, answer: "confirm", party_id: partyId },
  }));
}
