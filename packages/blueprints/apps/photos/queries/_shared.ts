/**
 * Shared bounded joins for the photos queries. FAVORITE IS DERIVED HERE (#916):
 * the star is the flags-scheme `starred` tag on `media.asset` — the same
 * SCHEME Docs, Locker and People read, each anchored on its own subject — not a
 * mirrored column. The `media_asset.favorite` column is gone, so a photo's star
 * is one row in one place, and there is nothing to keep in step.
 * NOT a query — the dispatcher resolves names straight to `queries/<name>.js`.
 */

import {
  FLAGS_SCHEME_URI,
  STARRED_NOTATION,
  TAGS_SCHEME_URI,
  conceptsInScheme,
  findScheme,
  findSchemeConcept,
} from "../../_shared/concept-scheme-kit.ts";

interface SrcContent {
  content_id?: string;
  content_uri?: unknown;
}

interface RawPlace {
  place_id: string;
  name: string;
  geo_lat?: number | null;
  geo_lng?: number | null;
  kind?: string | null;
  address_json?: string | null;
}

/** One bad address blob must not take the whole shelf down. */
function gazetteerOf(addressJson: string | null | undefined): string | null {
  if (typeof addressJson !== "string" || addressJson === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(addressJson);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const gazetteer = (parsed as { gazetteer?: unknown }).gazetteer;
  if (gazetteer === null || typeof gazetteer !== "object") return null;
  const name = (gazetteer as { name?: unknown }).name;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
}

interface SchemeRow {
  scheme_id: string;
  uri: string;
}

interface ConceptRow {
  concept_id: string;
  scheme_id: string;
  pref_label?: string | null;
  notation?: string | null;
}

interface TagRow {
  tag_id: string;
  concept_id: string;
  target_id: string;
  target_type?: string;
}

interface CustodyRow {
  content_id: string;
  custody_state?: string | null;
}

export const BLOB_ROUTE = "/centraid/_vault/blobs";

/** Blob bytes become same-origin serve URLs; `data:` URIs pass through. */
export function srcOf(content: SrcContent | undefined) {
  const uri = content?.content_uri;
  if (typeof uri !== "string")
    return { src: null, thumb: null, preview: null, poster: null };
  if (!uri.startsWith("blob:"))
    return { src: uri, thumb: null, preview: null, poster: null };
  const src = `${BLOB_ROUTE}/${content!.content_id}`;
  return {
    src,
    thumb: `${src}?variant=thumb`,
    preview: `${src}?variant=preview`,
    poster: `${src}?variant=poster`,
  };
}

export async function readPlaces({
  ctx,
  purpose,
}: {
  ctx: HandlerCtx;
  purpose: string;
}) {
  const result = await ctx.vault.read({
    acceptTruncation: true,
    entity: "core.place",
    purpose,
  });
  // Coordinates for the map — `null`, never 0°,0°; `kind` and gazetteer
  // because a location is a PHRASE before it is a pin.
  const rows = ((result.rows ?? []) as unknown as RawPlace[]).map((p) => ({
    place_id: p.place_id,
    name: p.name,
    lat: typeof p.geo_lat === "number" ? p.geo_lat : null,
    lng: typeof p.geo_lng === "number" ? p.geo_lng : null,
    kind: p.kind ?? null,
    gazetteer: gazetteerOf(p.address_json),
  }));
  return { rows, byId: new Map(rows.map((p) => [p.place_id, p] as const)) };
}

/** WINDOWED ids only — never a table scan. */
export async function readAssetJoins({
  ctx,
  purpose,
  assetIds,
  contentIds,
}: {
  ctx: HandlerCtx;
  purpose: string;
  assetIds: string[];
  contentIds: string[];
}) {
  const [schemes, concepts, custody] = await Promise.all([
    ctx.vault.read({
      acceptTruncation: true,
      entity: "core.concept_scheme",
      purpose,
    }),
    ctx.vault.read({ acceptTruncation: true, entity: "core.concept", purpose }),
    contentIds.length > 0
      ? ctx.vault.read({
          acceptTruncation: true,
          entity: "blob.custody_state",
          where: [{ column: "content_id", op: "in", value: contentIds }],
          purpose,
        })
      : { rows: [] },
  ]);

  // Tags target the ASSET; untag removes by tag_id, never by label.
  const schemeRows = (schemes.rows ?? []) as unknown as SchemeRow[];
  const conceptRows = (concepts.rows ?? []) as unknown as ConceptRow[];
  const custodyRows = (custody.rows ?? []) as unknown as CustodyRow[];
  const tagsScheme = findScheme(schemeRows, TAGS_SCHEME_URI);
  const labelConceptById = new Map<string, string | null | undefined>(
    conceptsInScheme(conceptRows, tagsScheme).map(
      (c) => [c.concept_id, c.pref_label ?? c.notation] as const
    )
  );
  // No flags scheme or no `starred` concept yet ⇒ nothing is starred. A vault
  // mints both the first time something is starred, so their absence is an
  // honest "none", never an error.
  const starredConcept = findSchemeConcept(
    schemeRows,
    conceptRows,
    FLAGS_SCHEME_URI,
    STARRED_NOTATION
  );
  const tagsByAsset = new Map<
    string,
    Array<{ tag_id: string; label: string }>
  >();
  const favoriteAssets = new Set<string>();
  // ONE read over the windowed assets' tags, then split by scheme: the label
  // rail and the star are two readings of the same rows.
  if (assetIds.length > 0) {
    const assetTags = await ctx.vault.read({
      acceptTruncation: true,
      entity: "core.tag",
      where: [
        { column: "target_type", op: "eq", value: "media.asset" },
        { column: "target_id", op: "in", value: assetIds },
      ],
      purpose,
    });
    for (const t of (assetTags.rows ?? []) as unknown as TagRow[]) {
      if (starredConcept && t.concept_id === starredConcept.concept_id) {
        favoriteAssets.add(t.target_id);
        continue;
      }
      const label = labelConceptById.get(t.concept_id);
      if (!label) continue; // from another scheme
      if (!tagsByAsset.has(t.target_id)) tagsByAsset.set(t.target_id, []);
      tagsByAsset.get(t.target_id)!.push({ tag_id: t.tag_id, label });
    }
  }

  const custodyByContent = new Map(
    custodyRows.map((c) => [c.content_id, c.custody_state] as const)
  );

  return { tagsByAsset, favoriteAssets, custodyByContent };
}
