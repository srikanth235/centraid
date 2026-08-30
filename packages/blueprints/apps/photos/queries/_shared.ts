/**
 * Shared bounded joins for the photos queries. FAVORITE IS NOT JOINED HERE:
 * it is a first-class `favorite` column on media.asset (#419), never a tag.
 * NOT a query — the dispatcher resolves names straight to `queries/<name>.js`.
 */

import {
  TAGS_SCHEME_URI,
  conceptsInScheme,
  findScheme,
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
  const result = await ctx.vault.read({ entity: "core.place", purpose });
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
    ctx.vault.read({ entity: "core.concept_scheme", purpose }),
    ctx.vault.read({ entity: "core.concept", purpose }),
    contentIds.length > 0
      ? ctx.vault.read({
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
  const tagsByAsset = new Map<
    string,
    Array<{ tag_id: string; label: string }>
  >();
  if (tagsScheme && assetIds.length > 0) {
    const labelTags = await ctx.vault.read({
      entity: "core.tag",
      where: [
        { column: "target_type", op: "eq", value: "media.asset" },
        { column: "target_id", op: "in", value: assetIds },
      ],
      purpose,
    });
    for (const t of (labelTags.rows ?? []) as unknown as TagRow[]) {
      const label = labelConceptById.get(t.concept_id);
      if (!label) continue; // from another scheme
      if (!tagsByAsset.has(t.target_id)) tagsByAsset.set(t.target_id, []);
      tagsByAsset.get(t.target_id)!.push({ tag_id: t.tag_id, label });
    }
  }

  const custodyByContent = new Map(
    custodyRows.map((c) => [c.content_id, c.custody_state] as const)
  );

  return { tagsByAsset, custodyByContent };
}
