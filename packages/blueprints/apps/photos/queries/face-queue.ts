/**
 * The Face review queue (issue #711): the vault-wide propose-and-confirm
 * backlog, read as one ORDERED queue the component walks one entry at a
 * time — never the whole backlog at once (v4 handoff §8, §16 `faces.note`:
 * "One face at a time"). `queries/faces.ts` stays the PER-ASSET read the
 * lightbox's own mini-list uses; this is the dedicated "Face review" surface
 * (v4 4305-4318) reachable on its own, over every unconfirmed face in the
 * vault rather than one photograph's.
 *
 * CONFIDENCE IS A MATCH COUNT, NEVER A PERCENTAGE (README.md:285). The
 * enricher's own `confidence` column is a 0-1 similarity score, but the
 * surface must say "N matching faces" — derived here by counting OTHER
 * `media_face_region` rows (any confirm state) that propose the SAME
 * `party_id`, deduped by photograph. No new column: the table already
 * carries what this needs, because every proposal for one person shares that
 * person's `party_id`.
 *
 * THE QUEUE IS ANSWERABLE (issue #712). It filters on `review_state`, not on
 * `confirmed_by_party_id`, and that is the whole difference between a queue
 * that can be finished and one that cannot. Every region the owner has
 * answered — confirmed, rejected, or dismissed ("reviewed, deliberately left
 * unnamed") — leaves this list for good, and the enricher may not put it
 * back (`ingest/enrich-publishers.ts` only refreshes a still-`proposed`
 * region). `rejectedTotal` is therefore a real number now, which is what
 * lets the surface's status note say what the prototype asks it to.
 *
 * ONE FACT THE PROTOTYPE ASKS FOR THAT THIS SCHEMA STILL CANNOT STATE —
 * flagged here rather than faked:
 *
 *  - `first seen` (4310) reads as the EARLIEST CAPTURE DATE among the
 *    matching photographs (`media_asset.captured_at`), not "when the
 *    enricher first proposed this face" — `media_face_region` has no
 *    `created_at` column, so that fact does not exist in this schema today.
 *    Capture date is the closest true substitute, not an invented one.
 *
 * @type {import('@centraid/server/engine').QueryHandler}
 */
import { srcOf } from "./_shared.ts";

// One page of the queue. The component walks it one entry at a time and
// only ever asks for more once this page is exhausted (skip cycles inside
// it), so this bounds the join work per read rather than the review itself.
const QUEUE_LIMIT = 60;

interface RawRegion {
  region_id: string;
  asset_id: string;
  bbox_json?: unknown;
  party_id?: string | null;
  confidence?: number | null;
  confirmed_by_party_id?: string | null;
  /** `proposed` | `confirmed` | `rejected` | `dismissed` (issue #712). */
  review_state?: string | null;
}
interface RawParty {
  party_id: string;
  kind?: string;
  display_name?: string | null;
}
interface RawAsset {
  asset_id: string;
  content_id: string;
  width?: number | null;
  height?: number | null;
  captured_at?: string | null;
}
interface RawContent {
  content_id: string;
  content_uri?: unknown;
}

export default async function faceQueue({ ctx }: HandlerArgs) {
  const purpose = "dpv:ServiceProvision";
  try {
    const [regionsResult, partiesResult] = await Promise.all([
      ctx.vault.read({ entity: "media.face_region", limit: 4000, purpose }),
      ctx.vault.read({
        entity: "core.party",
        orderBy: { column: "display_name", dir: "asc" },
        limit: 500,
        purpose,
      }),
    ]);
    const regions = (regionsResult.rows ?? []) as unknown as RawRegion[];
    const persons = (
      (partiesResult.rows ?? []) as unknown as RawParty[]
    ).filter((p) => p.kind === "person");
    const nameOf = new Map(
      persons.map((p) => [p.party_id, p.display_name] as const)
    );
    // UNANSWERED, not merely unconfirmed (issue #712). A rejected or
    // dismissed region is a decision the owner already made; re-offering it
    // is the bug this queue existed to have.
    const pending = regions.filter((r) => r.review_state === "proposed");
    const confirmedTotal = regions.filter(
      (r) => r.review_state === "confirmed"
    ).length;
    const rejectedTotal = regions.filter(
      (r) => r.review_state === "rejected"
    ).length;
    const dismissedTotal = regions.filter(
      (r) => r.review_state === "dismissed"
    ).length;
    // Deterministic order (no created_at to sort on): region_id, ascending.
    const queueSlice = [...pending]
      .sort((a, b) => (a.region_id < b.region_id ? -1 : 1))
      .slice(0, QUEUE_LIMIT);

    const assetIds = [...new Set(queueSlice.map((r) => r.asset_id))];
    const assetsResult = assetIds.length
      ? await ctx.vault.read({
          entity: "media.asset",
          where: [{ column: "asset_id", op: "in", value: assetIds }],
          limit: assetIds.length,
          purpose,
        })
      : { rows: [] };
    const assetById = new Map(
      ((assetsResult.rows ?? []) as unknown as RawAsset[]).map(
        (a) => [a.asset_id, a] as const
      )
    );
    const contentIds = [
      ...new Set([...assetById.values()].map((a) => a.content_id)),
    ];
    const contentsResult = contentIds.length
      ? await ctx.vault.read({
          entity: "core.content_item",
          where: [{ column: "content_id", op: "in", value: contentIds }],
          purpose,
        })
      : { rows: [] };
    const contentById = new Map(
      ((contentsResult.rows ?? []) as unknown as RawContent[]).map(
        (c) => [c.content_id, c] as const
      )
    );

    // Every OTHER region proposing the same party, deduped by photograph —
    // the match-count and first-seen derivations share this grouping.
    const assetIdsByParty = new Map<string, Set<string>>();
    for (const r of regions) {
      if (!r.party_id) continue;
      if (!assetIdsByParty.has(r.party_id))
        assetIdsByParty.set(r.party_id, new Set());
      assetIdsByParty.get(r.party_id)!.add(r.asset_id);
    }
    const matchCountFor = (region: RawRegion): number => {
      if (!region.party_id) return 0;
      const ids = assetIdsByParty.get(region.party_id);
      if (!ids) return 0;
      return ids.has(region.asset_id) ? ids.size - 1 : ids.size;
    };
    const firstSeenAtFor = (region: RawRegion): string | null => {
      const ids = region.party_id
        ? [...(assetIdsByParty.get(region.party_id) ?? [region.asset_id])]
        : [region.asset_id];
      let earliest: string | null = null;
      for (const id of ids) {
        const capturedAt = assetById.get(id)?.captured_at;
        if (capturedAt && (!earliest || capturedAt < earliest))
          earliest = capturedAt;
      }
      return earliest;
    };

    const queue = queueSlice.map((r) => {
      const asset = assetById.get(r.asset_id);
      const content = asset ? contentById.get(asset.content_id) : undefined;
      const { src, thumb } = srcOf(content);
      return {
        region_id: r.region_id,
        bbox: safeParse(r.bbox_json),
        party_id: r.party_id ?? null,
        person_name: r.party_id ? (nameOf.get(r.party_id) ?? null) : null,
        matchCount: matchCountFor(r),
        firstSeenAt: firstSeenAtFor(r),
        asset: asset
          ? {
              asset_id: asset.asset_id,
              content_uri: src,
              thumb_uri: thumb,
              width: asset.width ?? null,
              height: asset.height ?? null,
            }
          : null,
      };
    });

    return {
      status: 200,
      body: {
        queue,
        unmatchedTotal: pending.length,
        confirmedTotal,
        rejectedTotal,
        dismissedTotal,
        people: persons.map((p) => ({
          party_id: p.party_id,
          name: p.display_name,
        })),
      },
    };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === "VAULT_CONSENT") {
      return { status: 200, body: { denied: true, reason: e.message } };
    }
    return {
      status: 200,
      body: {
        queue: [],
        unmatchedTotal: 0,
        confirmedTotal: 0,
        rejectedTotal: 0,
        dismissedTotal: 0,
        people: [],
        error: String(e.message ?? error),
      },
    };
  }
}

function safeParse(json: unknown): unknown {
  try {
    return JSON.parse(String(json ?? "null"));
  } catch {
    return null;
  }
}
