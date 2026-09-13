import { inList, readPages } from "../../_shared/paged-reads.ts";
/**
 * Face review queue (#711): vault-wide, one entry at a time.
 * `queries/faces.ts` stays the per-asset lightbox read.
 *
 * Confidence is a match count, never a percentage: other regions proposing
 * the same `party_id`, deduped by photograph.
 *
 * Filters on `review_state`, not `confirmed_by_party_id` (#712). Confirmed /
 * rejected / dismissed leave this list; the enricher may not put them back.
 *
 * `first seen` is earliest `media_asset.captured_at` among matches —
 * `media_face_region` has no `created_at`. Do not invent proposal time.
 *
 * @type {import('@centraid/server/engine').QueryHandler}
 */
import { srcOf } from "./_shared.ts";

/** The review queue considers this many regions, and this many people. */
const REGION_ROWS = 4000;
const PARTY_ROWS = 500;

const QUEUE_LIMIT = 60;

interface RawRegion {
  region_id: string;
  asset_id: string;
  bbox_json?: unknown;
  party_id?: string | null;
  confidence?: number | null;
  confirmed_by_party_id?: string | null;
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
  try {
    const [regionsResult, partiesResult] = await Promise.all([
      ctx.vault.page<RawRegion>({
        query: {
          name: "photos.faceQueue.regions",
          select:
            "region_id, asset_id, bbox_json, party_id, confidence, confirmed_by_party_id, review_state, created_at",
          from: "media_face_region",
          order: {
            sortColumn: "region_id",
            pkColumn: "region_id",
            descending: false,
          },
        },
        limit: REGION_ROWS,
      }),
      ctx.vault.page<RawParty>({
        query: {
          name: "photos.faceQueue.parties",
          select: "party_id, display_name, kind",
          from: "core_party",
          order: {
            sortColumn: "display_name",
            pkColumn: "party_id",
            descending: false,
          },
        },
        limit: PARTY_ROWS,
      }),
    ]);
    const regions = regionsResult.rows;
    const persons = partiesResult.rows.filter((p) => p.kind === "person");
    const nameOf = new Map(
      persons.map((p) => [p.party_id, p.display_name] as const)
    );
    // Unanswered, not merely unconfirmed (#712).
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
    const queueSlice = [...pending]
      .sort((a, b) => (a.region_id < b.region_id ? -1 : 1))
      .slice(0, QUEUE_LIMIT);

    const assetIds = [...new Set(queueSlice.map((r) => r.asset_id))];
    const assetsResult = assetIds.length
      ? await readPages<RawAsset>(ctx, {
          name: "photos.faceQueue.assets",
          // `width`/`height` are SELECTED, not just declared: this statement's
          // own `RawAsset` carries them and the entry below maps
          // `asset.width ?? null`, so omitting them here made the queue card's
          // dimensions structurally null for every photograph in every vault
          // (#1020 R-1020-35; the red is
          // `the_face_queue_is_what_v0_answered` in
          // `crates/apps/photos/tests/parity.rs`, which read 270 off the same
          // row this query answered `null` for).
          select:
            "asset_id, content_id, kind, title, captured_at, width, height",
          from: "media_asset",
          where: inList("asset_id", assetIds).sql,
          bind: inList("asset_id", assetIds).bind,
          order: {
            sortColumn: "asset_id",
            pkColumn: "asset_id",
            descending: false,
          },
        })
      : [];
    const assetById = new Map(
      assetsResult.map((a) => [a.asset_id, a] as const)
    );
    const contentIds = [
      ...new Set([...assetById.values()].map((a) => a.content_id)),
    ];
    const contentsResult = contentIds.length
      ? await readPages<RawContent>(ctx, {
          name: "photos.faceQueue.contents",
          select: "content_id, content_uri, byte_size",
          from: "core_content_item",
          where: inList("content_id", contentIds).sql,
          bind: inList("content_id", contentIds).bind,
          order: {
            sortColumn: "content_id",
            pkColumn: "content_id",
            descending: false,
          },
        })
      : [];
    const contentById = new Map(
      contentsResult.map((c) => [c.content_id, c] as const)
    );

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
    if (e.code === "VAULT_ACCESS") {
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
