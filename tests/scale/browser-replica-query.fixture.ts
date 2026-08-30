/**
 * YEAR-3 REPLICA QUERY CORPUS (#883 C1).
 *
 * One deterministic 50,000-row canonical set plus the three read requests the
 * rig times, factored out of `browser-replica-query.scale.test.ts` so the
 * pushdown work (#883 C3) can build its PARITY ORACLE on exactly this corpus:
 * a pushed-down read is correct only if it returns the same rows, in the same
 * order, as the pure-TS evaluator does over the same input. Sharing the fixture
 * is what makes "same input" a fact rather than a claim.
 *
 * 50,000 rows is the repo's declared year-3 replica volume for one device
 * (`tests/experience-budgets/README.md`, `docs/mobile-offline.md`). The entity
 * is `core.content_item` — Photos and Docs both read it, and it is the largest
 * replicated table on a phone.
 *
 * Deterministic by construction: a seeded LCG, no clock, no randomness. Two
 * runs on two hosts build byte-identical rows, so a parity oracle comparing
 * two engines over this corpus is comparing engines and nothing else.
 */
import type {
  ReplicaReadRequest,
  ReplicaSnapshot,
  ReplicaSnapshotRow,
} from "../../packages/client/src/replica/types.js";

export const SHAPE_ID = "shape-library";
export const ENTITY = "core.content_item";
export const VAULT_ID = "vault-scale";

/** Declared year-3 replica rows on one device. */
export const ROW_COUNT = 50_000;

/**
 * Ids in the `in` filter. A thousand is the realistic worst case the product
 * already produces: an album, a selection, or a "these are the assets in this
 * memory" fan-out. It is also where the evaluator's cost turns quadratic —
 * `matches()` answers `in` with `clause.value.some(...)`, i.e. O(rows × ids) —
 * so this is the number that makes the hot spot visible.
 */
export const IN_ID_COUNT = 1_000;

const KINDS = ["photo", "video", "document", "note"] as const;

/** Mulberry32 — a small, seedable, fully specified PRNG. No host entropy. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function contentId(index: number): string {
  return `content-${index.toString().padStart(6, "0")}`;
}

/**
 * The canonical rows, in bootstrap order. Deliberately NOT pre-sorted by
 * `created_at`: a corpus already in the requested order would let a sort that
 * degraded to O(n²) on adversarial input still look fast.
 */
export function buildCorpus(
  rowCount: number = ROW_COUNT
): ReplicaSnapshotRow[] {
  const random = seededRandom(883_001);
  const rows: ReplicaSnapshotRow[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    // Three years of captures, shuffled across the range rather than walked.
    const capturedMs =
      Date.UTC(2023, 0, 1) + Math.floor(random() * 3 * 365 * 86_400_000);
    const kind = KINDS[Math.floor(random() * KINDS.length)] ?? "photo";
    rows.push({
      shapeId: SHAPE_ID,
      entity: ENTITY,
      rowId: contentId(index),
      values: {
        content_id: contentId(index),
        title: `Item ${index} ${kind}`,
        kind,
        // ~4% soft-deleted, the ratio a real library carries in its trash.
        deleted_at: random() < 0.04 ? new Date(capturedMs).toISOString() : null,
        created_at: new Date(capturedMs).toISOString(),
        byte_size: Math.floor(random() * 8_000_000),
        favorite: random() < 0.07 ? 1 : 0,
      },
    });
  }
  return rows;
}

export function buildSnapshot(rows: ReplicaSnapshotRow[]): ReplicaSnapshot {
  return {
    protocolVersion: 1,
    vaultId: VAULT_ID,
    schemaEpoch: "schema-1",
    cursor: { epoch: "replica-1", seq: 1 },
    shapes: [
      {
        shapeId: SHAPE_ID,
        appId: "photos",
        purpose: "dpv:ServiceProvision",
        entities: [
          {
            entity: ENTITY,
            primaryKey: "content_id",
            columns: [
              "content_id",
              "title",
              "kind",
              "deleted_at",
              "created_at",
              "byte_size",
              "favorite",
            ],
          },
        ],
      },
    ],
    rows,
  };
}

/**
 * Every id in the `in` filter EXISTS in the corpus, spread evenly across it.
 * A filter over ids that mostly miss would exit `some()` late and read fast for
 * the wrong reason; a filter over a contiguous prefix would exit early. An even
 * spread is the honest middle.
 */
export function inFilterIds(
  count: number = IN_ID_COUNT,
  rowCount: number = ROW_COUNT
): string[] {
  const stride = Math.floor(rowCount / count);
  return Array.from({ length: count }, (_unused, position) =>
    contentId(position * stride)
  );
}

/** The three reads the rig times, named so both engines run the same ones. */
export const READ_REQUESTS: Readonly<Record<string, ReplicaReadRequest>> = {
  /** Everything the shape holds — the read a cold app mount pays for. */
  fullEntity: {
    shapeId: SHAPE_ID,
    entity: ENTITY,
    limit: 100_000,
  },
  /** The Photos timeline: live photos, newest first, one screen of them. */
  filteredSorted: {
    shapeId: SHAPE_ID,
    entity: ENTITY,
    where: [
      { column: "deleted_at", op: "is-null" },
      { column: "kind", op: "eq", value: "photo" },
    ],
    orderBy: { column: "created_at", dir: "desc" },
    limit: 200,
  },
  /** An album/selection fan-out: 1,000 ids against every row. */
  inFilter: {
    shapeId: SHAPE_ID,
    entity: ENTITY,
    where: [{ column: "content_id", op: "in", value: inFilterIds() }],
    limit: IN_ID_COUNT,
  },
};
