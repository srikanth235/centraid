/**
 * The People shelf's roster (v4 handoff §5): every person the member has
 * CONFIRMED on a face, with how many photographs carry them and which ones —
 * PLUS, since issue #711's review, the unconfirmed proposals sitting beside
 * them (v4 handoff proto :3760 `PPEOPLE`: named cards next to "Unnamed"
 * cards, each with its own count — "People as a browsable set. Unnamed
 * people are shown as unnamed, not hidden.").
 *
 * The two stay in SEPARATE arrays (`people` / `proposals`), never merged
 * into one list, because they answer different questions with different
 * truth values:
 *   - `people`: "who is in my library" — a name the member said yes to.
 *   - `proposals`: "what has the enricher noticed that nobody has named or
 *     rejected yet" — evidence, not an identity. A proposal NEVER carries a
 *     `name`; the type has no field for one, so a caller cannot render a
 *     name for a proposal by accident.
 *
 * HOW A PROPOSAL IS GROUPED — and the one honest limit of this grouping:
 * `media_face_region.party_id` is "candidate person from the People match,
 * WHEN THE MODEL OFFERED ONE" (enrich-publishers.ts's own doc comment on
 * `FaceRegionPayload`) — nullable, and never treated as a name here even
 * when it resolves to an already-confirmed party, because THIS region was
 * never confirmed as them. Regions that share a non-null `party_id` are one
 * proposal (the model's own claim that they are the same face, across
 * however many photographs). A region with no candidate at all is its own
 * proposal of one — which is *every* region today: no shipped producer of
 * face regions sets `party_id` at all. (The `face-proposer` automation that
 * used to write them was deleted in issue #712 — face detection is becoming
 * the Photos app's own, and it will be identity-blind for the same reason:
 * naming a person is the owner's assertion, made in the app.) That is not
 * this query approximating anything: there is no face-similarity signal in
 * this schema to group strangers by today, so every unconfirmed face
 * honestly IS its own proposal until an identity-matching enricher ships —
 * at which point regions sharing its `party_id` group for free, no shape
 * change needed here.
 *
 * `unmatchedTotal` is the same count `queries/face-queue.ts` derives for the
 * Face Review surface (same entity, same `review_state = 'proposed'` filter,
 * issue #712 — an answered region, rejected or deliberately left unnamed, is
 * not pending on either surface) — computed once here so the People shelf's
 * pending note no longer needs its own separate read of a different query to
 * say a true number.
 *
 * `asset_ids` rides along so one read serves both halves of the shelf — the
 * card grid AND one person's own timeline sub-state — without a second round
 * trip per person. It is bounded by the same window the region read is.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders it
 * as the permission screen (§13).
 *
 * @type {import('@centraid/app-engine').QueryHandler}
 */
import { groupPeopleFaces } from "../../_shared/people-counts.ts";
import { srcOf } from "./_shared.ts";

interface RawRegion {
  region_id: string;
  asset_id?: string | null;
  bbox_json?: unknown;
  party_id?: string | null;
  confirmed_by_party_id?: string | null;
  /** `proposed` | `confirmed` | `rejected` | `dismissed` (issue #712). */
  review_state?: string | null;
}

interface RawParty {
  party_id: string;
  kind?: string;
  display_name?: string | null;
}

interface RawCluster {
  region_id: string;
  cluster_id: string;
}

interface RawAsset {
  asset_id: string;
  content_id: string;
  width?: number | null;
  height?: number | null;
}

interface RawContent {
  content_id: string;
  content_uri?: unknown;
}

/** How many confirmed+unconfirmed regions one read covers. A face region is
 *  one row per person per photograph, so this is a photograph budget, not a
 *  person one. Matches `queries/face-queue.ts`'s own bound so the two
 *  queries see the same backlog and can never disagree on its size. */
const REGION_LIMIT = 4000;

/** How many unconfirmed proposal GROUPS the shelf shows a cover for. The
 *  grid teases the backlog (a handful of covers); Face Review is where the
 *  member works the whole thing one at a time (§8). Bounding this is what
 *  keeps the grid's asset+content join cheap on a library with a large
 *  unreviewed backlog. */
const PROPOSAL_LIMIT = 60;

interface ProposalGroup {
  partyId: string | null;
  assetIds: Set<string>;
  /** The region this group's cover crop is drawn from — its own bbox and
   *  asset, first-seen order (region_id ascending, same tiebreak
   *  face-queue.ts uses since there is no created_at column to sort on). */
  coverRegion: RawRegion;
}

export default async function people({ ctx }: HandlerArgs) {
  const purpose = "dpv:ServiceProvision";
  try {
    const [regionsResult, partiesResult, clustersResult] = await Promise.all([
      ctx.vault.read({
        entity: "media.face_region",
        limit: REGION_LIMIT,
        purpose,
      }),
      ctx.vault.read({
        entity: "core.party",
        orderBy: { column: "display_name", dir: "asc" },
        limit: 500,
        purpose,
      }),
      ctx.vault.read({
        entity: "media.face_cluster",
        limit: REGION_LIMIT,
        purpose,
      }),
    ]);
    const regions = (regionsResult.rows ?? []) as unknown as RawRegion[];
    const clusters = (clustersResult.rows ?? []) as unknown as RawCluster[];
    const nameOf = new Map(
      ((partiesResult.rows ?? []) as unknown as RawParty[])
        .filter((party) => party.kind === "person")
        .map((party) => [party.party_id, party.display_name] as const)
    );

    const grouped = groupPeopleFaces(regions, clusters);
    const regionById = new Map(
      regions.map((region) => [region.region_id, region] as const)
    );

    // ── unconfirmed proposals — grouped, never named (see file header) ──
    // Still-open proposals only: a rejected or dismissed region has been
    // answered, so it is neither a person's face nor anybody's backlog.
    const proposalGroups = new Map<string, ProposalGroup>();
    for (const group of grouped.pendingByParty) {
      const coverRegion = group.coverRegionId
        ? regionById.get(group.coverRegionId)
        : undefined;
      if (!coverRegion) continue;
      proposalGroups.set(`party:${group.id}`, {
        partyId: group.id,
        assetIds: new Set(group.assetIds),
        coverRegion,
      });
    }
    for (const group of grouped.unnamed) {
      const coverRegion = group.coverRegionId
        ? regionById.get(group.coverRegionId)
        : undefined;
      if (!coverRegion) continue;
      proposalGroups.set(`cluster:${group.id}`, {
        partyId: null,
        assetIds: new Set(group.assetIds),
        coverRegion,
      });
    }
    const orderedGroups = [...proposalGroups.entries()].sort(([a], [b]) =>
      a < b ? -1 : 1
    );
    const coverGroups = orderedGroups.slice(0, PROPOSAL_LIMIT);

    const coverAssetIds = [
      ...new Set(
        coverGroups
          .map(([, g]) => g.coverRegion.asset_id)
          .filter((id): id is string => Boolean(id))
      ),
    ];
    const assetsResult = coverAssetIds.length
      ? await ctx.vault.read({
          entity: "media.asset",
          where: [{ column: "asset_id", op: "in", value: coverAssetIds }],
          limit: coverAssetIds.length,
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

    const proposals = coverGroups.map(([key, group]) => {
      const asset = group.coverRegion.asset_id
        ? assetById.get(group.coverRegion.asset_id)
        : undefined;
      const content = asset ? contentById.get(asset.content_id) : undefined;
      const { src, thumb } = srcOf(content);
      return {
        cluster_id: key,
        // Carried for reference (e.g. spotting the same candidate across
        // reloads) — NEVER resolved to a name here. See file header.
        party_id: group.partyId,
        // Distinct photographs behind this proposal — an exact count, never
        // an estimate, the same contract `Person.count` holds.
        count: group.assetIds.size,
        region_id: group.coverRegion.region_id,
        cover: asset
          ? {
              asset_id: asset.asset_id,
              content_uri: src,
              thumb_uri: thumb,
              width: asset.width ?? null,
              height: asset.height ?? null,
              bbox: safeParse(group.coverRegion.bbox_json),
            }
          : null,
      };
    });

    return {
      people: grouped.confirmed
        .filter((entry) => nameOf.has(entry.id))
        .map((entry) => ({
          party_id: entry.id,
          name: nameOf.get(entry.id) ?? null,
          count: entry.assetIds.length,
          asset_ids: entry.assetIds,
          // The distinct parties who answered, each carrying whatever name
          // `core.party` holds for them — `null` where the confirmer is not a
          // `kind = 'person'` party this read named (a device or a service that
          // acted for the owner), which the view renders as "someone else on
          // this library" rather than as an invented name.
          confirmed_by: entry.confirmerIds.map((confirmerId) => ({
            party_id: confirmerId,
            name: nameOf.get(confirmerId) ?? null,
          })),
        })),
      proposals,
      // Same derivation as face-queue.ts's `unmatchedTotal` — the pending
      // note's live count, not the (usually smaller) number of proposal
      // GROUPS rendered above.
      unmatchedTotal: grouped.pendingTotal,
    };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === "VAULT_CONSENT") {
      return {
        people: [],
        proposals: [],
        unmatchedTotal: 0,
        vaultDenied: { code: e.code, message: e.message },
      };
    }
    return {
      people: [],
      proposals: [],
      unmatchedTotal: 0,
      error: String(e.message ?? error),
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
