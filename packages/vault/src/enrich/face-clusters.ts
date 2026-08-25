// Face grouping (#724). PARTY-ANCHORED: identity is a `core_party` row the
// owner asserts via `media.answer_face_proposal`; this module never creates or
// confirms one. It only writes candidate `party_id`s onto PROPOSED regions and
// groups the rest into `media_face_cluster`, a rebuildable projection.
//
// ANSWERED REGIONS ARE READ FOR NOTHING — `rejected`/`dismissed` are never
// centroid material, candidates, or targets: a queue whose answers the next
// sweep can undo can never be finished (#712).
//
// EVERY COMPARISON HAPPENS WITHIN ONE MODEL: cosine distance across embedders
// is meaningless, so the pass partitions by `enrich_embedding.model` and a
// model upgrade re-proposes rather than inheriting dead centroids.
//
// THE THRESHOLDS ARE STRICTER THAN THE LITERATURE, ON PURPOSE: a false merge
// is found late and destroys trust; a false split costs one gesture.
//
// NO CHAINING: greedy agglomerative on CENTROID linkage, never the single-link
// union-find of `clusters.ts`, which would walk from one person to another
// through faces resembling both. Ascending distance, id tiebreak, so a rebuild
// is byte-stable.
import type { DatabaseSync } from "node:sqlite";

import { nowIso } from "../ids.js";
import { cosine, decodeVector } from "./similarity.js";

export const FACE_REGION_TARGET_TYPE = "media.face_region";

/** Offer-as-party ceiling; see the header before relaxing it. */
export const FACE_PARTY_MAX_DISTANCE = 0.3;

/** Stricter still: a stranger group is named in ONE gesture. */
export const FACE_CLUSTER_MAX_DISTANCE = 0.22;

/**
 * A lone face is named from its own photograph's review; grouping singletons
 * would fill the People shelf with strangers seen once.
 */
export const FACE_MIN_CLUSTER_SIZE = 2;

export interface FaceClusterResult {
  /** Proposed regions this pass wrote a candidate party onto. */
  matched: number;
  clusters: number;
  /** Excludes ungrouped singletons. */
  clustered: number;
  /** Rows actually inserted, updated or deleted. */
  updated: number;
}

interface RegionRow {
  region_id: string;
  party_id: string | null;
  confirmed_by_party_id: string | null;
  review_state: string;
  model: string;
  vector: Uint8Array;
}

interface Candidate {
  regionId: string;
  unit: Float32Array;
}

/**
 * L2-normalise once, so comparisons are dot products and centroids plain
 * means. A zero vector is dropped, never given an arbitrary direction.
 */
function unitOf(blob: Uint8Array): Float32Array | null {
  const values = decodeVector(Buffer.from(blob));
  let norm = 0;
  for (const value of values) norm += value * value;
  if (!(norm > 0) || !Number.isFinite(norm)) return null;
  const scale = 1 / Math.sqrt(norm);
  const unit = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) unit[i] = values[i]! * scale;
  return unit;
}

function centroidOf(members: readonly Float32Array[]): Float32Array | null {
  const first = members[0];
  if (!first) return null;
  const comparable = members.filter((member) => member.length === first.length);
  const sum = Array.from({ length: first.length }, (_unused, i) =>
    comparable.reduce((total, member) => total + (member[i] ?? 0), 0)
  );
  const norm = sum.reduce((total, value) => total + value * value, 0);
  if (!(norm > 0)) return null;
  const scale = 1 / Math.sqrt(norm);
  return Float32Array.from(sum, (value) => value * scale);
}

/** Incomparable widths are "as far apart as possible". */
function distance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 2;
  return 1 - cosine(a, b);
}

interface Group {
  /** Kept sorted: the lowest id is the group's identity. */
  members: string[];
  centroid: Float32Array;
}

/**
 * Ascending distance, ties broken by region id: the output must stay a pure
 * function of the input — no clock, no map-iteration order.
 */
function agglomerate(
  candidates: readonly Candidate[],
  threshold: number
): Group[] {
  const groups = new Map<string, Group>();
  for (const candidate of candidates) {
    groups.set(candidate.regionId, {
      members: [candidate.regionId],
      centroid: candidate.unit,
    });
  }
  // Quadratic is fine here: face counts run to thousands, unlike the phash
  // sidecar whose input is the whole library.
  const pairs: { a: string; b: string; d: number }[] = [];
  for (let i = 0; i < candidates.length; i += 1)
    for (let j = i + 1; j < candidates.length; j += 1) {
      const d = distance(candidates[i]!.unit, candidates[j]!.unit);
      if (d <= threshold)
        pairs.push({
          a: candidates[i]!.regionId,
          b: candidates[j]!.regionId,
          d,
        });
    }
  pairs.sort((x, y) => {
    if (x.d !== y.d) return x.d - y.d;
    if (x.a !== y.a) return x.a < y.a ? -1 : 1;
    return x.b < y.b ? -1 : 1;
  });

  // A merge rewrites the absorbed group's members rather than leaving a chain,
  // so lookup stays one hop.
  const rootOf = new Map<string, string>();
  for (const candidate of candidates)
    rootOf.set(candidate.regionId, candidate.regionId);
  const unitById = new Map(candidates.map((c) => [c.regionId, c.unit]));

  for (const pair of pairs) {
    const ra = rootOf.get(pair.a) as string;
    const rb = rootOf.get(pair.b) as string;
    if (ra === rb) continue;
    const ga = groups.get(ra);
    const gb = groups.get(rb);
    if (!ga || !gb) continue;
    // THE NO-CHAINING RULE (header): merge only when the two CENTROIDS are
    // themselves within the threshold.
    if (distance(ga.centroid, gb.centroid) > threshold) continue;
    const members = [...ga.members, ...gb.members].sort();
    const centroid = centroidOf(
      members
        .map((id) => unitById.get(id))
        .filter((u): u is Float32Array => u !== undefined)
    );
    if (!centroid) continue;
    // Lowest region id is the identity here and in the projection, so an
    // unchanged group never renames itself between passes.
    const survivor = members[0] as string;
    groups.delete(ra);
    groups.delete(rb);
    groups.set(survivor, { members, centroid });
    for (const member of members) rootOf.set(member, survivor);
  }
  return [...groups.values()].filter(
    (group) => group.members.length >= FACE_MIN_CLUSTER_SIZE
  );
}

/**
 * Holds nothing between calls, so it is safe on any cadence and from cold.
 * Idempotent by compare-then-write: unchanged data writes nothing, dirties no
 * WAL pages, wakes no replica.
 */
export function rebuildFaceClusters(
  vault: DatabaseSync,
  options: { now?: string } = {}
): FaceClusterResult {
  const now = options.now ?? nowIso();
  const rows = vault
    .prepare(
      `SELECT r.region_id     AS region_id,
              r.party_id      AS party_id,
              r.confirmed_by_party_id AS confirmed_by_party_id,
              r.review_state  AS review_state,
              e.model         AS model,
              e.vector        AS vector
         FROM media_face_region r
         JOIN media_asset a ON a.asset_id = r.asset_id
         JOIN enrich_embedding e
           ON e.target_type = ? AND e.target_id = r.region_id
        WHERE a.deleted_at IS NULL
          AND r.review_state IN ('proposed','confirmed')
        ORDER BY e.model, r.region_id`
    )
    .all(FACE_REGION_TARGET_TYPE) as unknown as RegionRow[];

  const result: FaceClusterResult = {
    matched: 0,
    clusters: 0,
    clustered: 0,
    updated: 0,
  };

  const byModel = new Map<string, RegionRow[]>();
  for (const row of rows) {
    const group = byModel.get(row.model);
    if (group) group.push(row);
    else byModel.set(row.model, [row]);
  }

  const assign = vault.prepare(
    // `review_state` is deliberately NOT touched — only the owner's own verb
    // (`media.answer_face_proposal`) moves a region out of 'proposed'.
    "UPDATE media_face_region SET party_id = ? WHERE region_id = ? AND review_state = 'proposed'"
  );
  const clusterOf = new Map<string, string>();

  for (const model of [...byModel.keys()].sort()) {
    const group = byModel.get(model) as RegionRow[];

    // Centroids come from the owner's confirmations. `party_id` is WHO the
    // face is; `confirmed_by_party_id` is who said so — never group on it.
    const confirmedByParty = new Map<string, Float32Array[]>();
    for (const row of group) {
      if (row.review_state !== "confirmed" || !row.party_id) continue;
      const unit = unitOf(row.vector);
      if (!unit) continue;
      const members = confirmedByParty.get(row.party_id);
      if (members) members.push(unit);
      else confirmedByParty.set(row.party_id, [unit]);
    }
    const centroids: { partyId: string; centroid: Float32Array }[] = [];
    for (const partyId of [...confirmedByParty.keys()].sort()) {
      const centroid = centroidOf(
        confirmedByParty.get(partyId) as Float32Array[]
      );
      if (centroid) centroids.push({ partyId, centroid });
    }

    // Assign only when EXACTLY one party is near: two near parties means the
    // enricher does not know, and leaving the region unnamed says so.
    const leftovers: Candidate[] = [];
    for (const row of group) {
      if (row.review_state !== "proposed") continue;
      const unit = unitOf(row.vector);
      if (!unit) continue;
      if (row.party_id) continue; // already carries a candidate — not ours to move
      const near = centroids.filter(
        (entry) => distance(unit, entry.centroid) <= FACE_PARTY_MAX_DISTANCE
      );
      if (near.length === 1) {
        const changed = assign.run(near[0]!.partyId, row.region_id).changes;
        if (Number(changed) > 0) result.matched += 1;
        continue;
      }
      leftovers.push({ regionId: row.region_id, unit });
    }

    for (const cluster of agglomerate(leftovers, FACE_CLUSTER_MAX_DISTANCE)) {
      const clusterId = cluster.members[0] as string;
      result.clusters += 1;
      for (const member of cluster.members) clusterOf.set(member, clusterId);
    }
  }
  result.clustered = clusterOf.size;

  // Compare-then-write: the projection is recomputed wholesale (nothing reads
  // its own previous output) but only moved rows are written.
  const existing = new Map(
    (
      vault
        .prepare("SELECT region_id, cluster_id FROM media_face_cluster")
        .all() as unknown as { region_id: string; cluster_id: string }[]
    ).map((row) => [row.region_id, row.cluster_id])
  );
  const upsert = vault.prepare(
    `INSERT INTO media_face_cluster (region_id, cluster_id, computed_at)
     VALUES (?, ?, ?)
     ON CONFLICT (region_id) DO UPDATE SET
       cluster_id = excluded.cluster_id, computed_at = excluded.computed_at`
  );
  const drop = vault.prepare(
    "DELETE FROM media_face_cluster WHERE region_id = ?"
  );
  for (const [regionId, clusterId] of [...clusterOf].sort(([a], [b]) =>
    a < b ? -1 : 1
  )) {
    if (existing.get(regionId) === clusterId) continue;
    upsert.run(regionId, clusterId, now);
    result.updated += 1;
  }
  for (const regionId of [...existing.keys()].sort()) {
    if (clusterOf.has(regionId)) continue;
    drop.run(regionId);
    result.updated += 1;
  }
  return result;
}
