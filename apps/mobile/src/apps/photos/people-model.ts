// The People shelf's model (issue #724 W5): who is in this library, who is
// waiting to be named, and what the member may do about it. Pure — no React,
// no navigation, no theme — so every claim below is testable as a claim.
//
// WHAT CHANGED, AND WHY THIS FILE EXISTS. Until W5 there was no
// face-similarity signal in the schema at all, and the blueprint's own
// `queries/people.ts` said so plainly: "every unconfirmed face honestly IS its
// own proposal until an identity-matching enricher ships — at which point
// regions sharing its `party_id` group for free". Both halves of that arrived
// with W5: proposals near a confirmed person now carry that person's
// `party_id` as a CANDIDATE, and the strangers left over are grouped in
// `media_face_cluster`. So the shelf has, for the first time, two honest
// sections instead of one: people, and groups-waiting-for-a-name.
//
// THE THREE KINDS OF ROW, AND WHY THEY ARE NEVER MERGED INTO ONE LIST.
//
//   `people` — the member said yes. Counted from CONFIRMED regions only
//     (`review_state = 'confirmed'`, which the schema pins to
//     `confirmed_by_party_id IS NOT NULL`). A named card is an assertion, and
//     the only thing that may make one is the member's own answer.
//   `pendingByParty` — a candidate: "these look like Ana". It is a QUESTION,
//     it carries the party id so the review surface can phrase it, and it
//     deliberately has no `name` field of its own so a caller cannot render it
//     as a person by accident.
//   `unnamed` — a group of strangers, keyed by `cluster_id`. It has no party
//     and no name, and naming it is one gesture over the whole group.
//
// COUNTS ARE PHOTOGRAPHS, NOT REGIONS. Two faces of one person in one
// photograph is one photograph. A count that said two would disagree with the
// tiles the shelf then shows, which is the version of dishonesty a member
// actually notices.

import { groupPeopleFaces } from "@centraid/blueprints/apps/_shared/people-counts";
//
// "DETECT FACES" IS GATED ON THE GATEWAY RUNG, NOT THE DEVICE ONE. The pass
// that answers this ask is the gateway's own faces sweep, so the tier that
// makes it possible is `gateway`. `deviceAnswerFor` (the shared consent
// helper) answers a different question — whether the ON-DEVICE promise is
// true — and returns `available: false` for exactly this tier. The two are
// complementary rungs of the same policy, and a surface offering both must ask
// each helper its own question rather than reusing one answer for both.
//
// HONEST ABSENCE. Nothing here invents a cover, a name, or a count. A person
// with no readable photograph gets `cover: null`, not a placeholder; a library
// with no faces gets a sentence naming what would put one there and what this
// product will not do on its own, in the voice `photos-collections.ts` uses.

/** One `media.face_region` row, as the replica hands it over. */
export interface FaceRegionRow {
  region_id: string;
  asset_id?: string | null;
  party_id?: string | null;
  confirmed_by_party_id?: string | null;
  review_state?: string | null;
  bbox_json?: unknown;
}

/** One `core.party` row. */
export interface PartyRow {
  party_id: string;
  kind?: string | null;
  display_name?: string | null;
}

/** One `media.face_cluster` row — the grouping projection (issue #724 W5). */
export interface FaceClusterRow {
  region_id: string;
  cluster_id: string;
}

/** One `enrich.policy` row — the app-readable tier mirror. */
export interface EnrichPolicyRow {
  domain?: string | null;
  tier?: string | null;
}

/** The photograph a card shows, and the box to crop it to. */
export interface PeopleCover {
  assetId: string;
  regionId: string;
  /** `{x, y, w, h}` as fractions of the whole photograph, or null if unparseable. */
  bbox: { x: number; y: number; w: number; h: number } | null;
}

export interface PersonEntry {
  partyId: string;
  /** The party's own name, or null — "Unnamed" is the VIEW's word, not this
   *  model's, because a null here is a fact and a label is a rendering. */
  name: string | null;
  /** Distinct photographs carrying a CONFIRMED face of this person. */
  count: number;
  cover: PeopleCover | null;
}

export interface PendingEntry {
  /** The party these faces are proposed AS. Never resolved to a name here. */
  partyId: string;
  /** Distinct photographs behind the proposal. */
  count: number;
  cover: PeopleCover | null;
}

export interface UnnamedGroupEntry {
  /** `media_face_cluster.cluster_id` — the group's lowest region id. */
  clusterId: string;
  /** Distinct photographs in the group. */
  count: number;
  /** Every region in the group, so naming it is one gesture over all of them. */
  regionIds: string[];
  cover: PeopleCover | null;
}

/** Whether the owner may ask for face detection, and why not when they may not. */
export interface DetectFacesAvailability {
  available: boolean;
  /** A sentence to show in place of the action. Absent when it is available. */
  reason?: string;
}

export interface PeopleShelf {
  people: PersonEntry[];
  pendingByParty: PendingEntry[];
  unnamed: UnnamedGroupEntry[];
  /** Proposed regions nobody has answered — the review queue's real size. */
  pendingTotal: number;
  /** What the shelf says when it holds nothing at all. */
  empty: string;
  detectFaces: DetectFacesAvailability;
}

export interface PeopleFacts {
  faces: readonly FaceRegionRow[];
  parties: readonly PartyRow[];
  clusters: readonly FaceClusterRow[];
  policies: readonly EnrichPolicyRow[];
  /** True while the policy read is still in flight — see `detectFacesFor`. */
  policiesLoading?: boolean;
}

/**
 * The empty state. Same grammar as every other shelf on the Collections page:
 * say what would put something here, then say what this product does NOT do on
 * its own — which for faces is the whole point.
 */
export const PEOPLE_EMPTY =
  "Face detection runs when you ask for it, never on its own. Once it has, the people it finds wait here for you to name — and nobody is named until you name them.";

/** Shown when the owner has asked but nothing has been detected yet. */
export const PEOPLE_PENDING_EMPTY =
  "Face detection was asked for and has not finished. Photographs are read on this gateway, and nothing leaves it.";

const DETECT_REASONS = {
  off: "Enrichment is switched off for photographs, so nothing may look at them. You can change that in Privacy.",
  device:
    "Photographs are set to be enriched on this device only. Face detection runs on the gateway, so it stays unavailable until you allow that in Privacy.",
  unknown: "This library has not said yet how far enrichment may run.",
} as const;

/**
 * Whether "Detect faces" may be offered. Reads the `enrich.policy` mirror's
 * photos row; the `gateway` rung is the one the faces sweep runs at.
 *
 * COMPAT(enrich-tier-rename #712): `model` is the pre-rename name for
 * `gateway`, and a row written before that rename must not silently read as
 * "not allowed" — a legacy value staying legible is the whole reason the
 * schema's CHECK still accepts it.
 */
export function detectFacesFor(
  tier: string | null | undefined
): DetectFacesAvailability {
  if (tier === "gateway" || tier === "model") return { available: true };
  if (tier === "device" || tier === "local")
    return { available: false, reason: DETECT_REASONS.device };
  if (tier === "off") return { available: false, reason: DETECT_REASONS.off };
  // `null` is "not read yet", which is not a refusal — no reason is offered,
  // because there is nothing true to say until the read lands.
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

/**
 * The cover of a set of regions: the EARLIEST region id with a photograph
 * behind it. Region ids sort stably (they are derived from the asset, the
 * model and the box — see the `faces` automation), so a cover does not shuffle
 * between loads the way a "newest" or "highest confidence" rule would.
 */
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

/**
 * Build the whole shelf from the four replica reads it needs. Deterministic:
 * people are ordered by name (nameless last, then by party id), pending
 * proposals and unnamed groups by size then by id, so the same library renders
 * the same shelf every time.
 */
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
      // A named person before an unnamed one; then by name; then by id. The
      // shelf's order is a rendering decision, but it must be a STABLE one.
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

  // Unnamed groups come from the projection, intersected with the regions this
  // read actually carries: a cluster row whose region is not in `faces` (it was
  // answered, or the read was windowed) contributes nothing rather than a card
  // with a count the member cannot open.
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
    // Which sentence is honest depends on whether anything is in flight: a
    // member who already asked is owed "it has not finished", not a second
    // invitation to ask.
    empty: facts.faces.length > 0 ? PEOPLE_PENDING_EMPTY : PEOPLE_EMPTY,
    detectFaces: detectFacesFor(tier),
  };
}

/** The write one "Detect faces" answer makes. Shape only — the caller sends it. */
export interface DetectFacesIntent {
  action: "request-enrichment";
  input: { entity_type: "media.media_asset" };
}

/**
 * The vault-wide ask. `reason: 'manual'` and `capability: 'faces'` are pinned
 * SERVER-side by the blueprint action, not sent from here, so a client cannot
 * widen its own consent by editing an input — see
 * `packages/blueprints/apps/photos/actions/request-enrichment.ts`.
 */
export function detectFacesIntent(): DetectFacesIntent {
  return {
    action: "request-enrichment",
    input: { entity_type: "media.media_asset" },
  };
}

/** One `answer-face` write. Naming a group is a list of these, one per region. */
export interface NameFaceIntent {
  action: "answer-face";
  input: { region_id: string; answer: "confirm"; party_id: string };
}

/**
 * Naming an unnamed group: one confirm per region, all onto the same party.
 *
 * IT IS DELIBERATELY NOT ONE COMMAND. `media.answer_face_proposal` answers ONE
 * proposal, and that is the right grain: the member is asserting a fact about
 * each face, and a batch verb would let one gesture record an assertion about a
 * face the member never saw. The batching lives here, in the surface that
 * showed them the group — so every row still gets its own answer, its own
 * receipt, and its own chance to be wrong on its own.
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
