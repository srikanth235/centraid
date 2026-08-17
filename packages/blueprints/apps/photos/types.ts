// Shared page-side shapes for the photos app (TS conversion). Type-only — no
// runtime members — so every importer uses `import type`, which esbuild strips
// at serve time (a value import of this module would 404). Grounded in the
// query payloads: an `Asset` is one row of `queries/library.js`'s `join()`
// output (the same shape `queries/search.js` and the trash shelf return);
// `Album`/`Place`/`AssetTag` are the joined sub-shapes. The permissive index
// signature is deliberate: assets originate as vault rows (`Record<string,
// unknown>`) spread through `...asset`, and `format.js`/`media.js` read a few
// forward-compatible columns (`bytes`, `size_bytes`, EXIF keys) this app does
// not otherwise name — the index signature keeps those honest as `unknown`
// without an `any`.
import type { TripRoutePoint } from "./trips.ts";

/** A free-form label on an asset (core.tag_item, issue #352). */
export interface AssetTag {
  tag_id: string;
  label: string;
}

/** A linked place (core.place) — the lightbox picker offers the known list. */
export interface Place {
  place_id: string;
  name: string;
  /** Where it is, when anything knows — the Places map plots these. Null for
   *  a place with no geography (a room, a venue someone simply named). */
  lat?: number | null;
  lng?: number | null;
  /** `core_place.kind` — `'home'` is the one value the phrase ladder reads,
   *  because "3.4 km NE of Home" needs to know which place is home. */
  kind?: string | null;
  /** A settlement name from the opt-in gazetteer automation, lifted out of
   *  `core_place.address_json`. Null until that automation writes one — the
   *  ladder simply skips the rung. */
  gazetteer?: string | null;
}

/** One decorated library/search/trash row (queries/library.js `join()`). */
export interface Asset {
  asset_id: string;
  /**
   * Which mounted scope this row is shown FROM (issue #599) — stamped by the
   * merge (apps/_shared/scope-merge.ts), absent on a single-scope surface.
   * Two things depend on
   * it: every blob reference painted for this asset carries it as `data-scope`
   * (content ids are per-scope and collide across scopes by design, so an
   * unscoped reference renders the WRONG image), and every write about this
   * asset is addressed at it.
   */
  scope_id?: string | null;
  content_id?: string | null;
  favorite?: number | boolean | null;
  content_uri?: string | null;
  thumb_uri?: string | null;
  preview_uri?: string | null;
  poster_uri?: string | null;
  byte_size?: number | null;
  bytes?: number | null;
  size_bytes?: number | null;
  media_type?: string | null;
  title?: string | null;
  kind?: string | null;
  taken_at?: string | null;
  captured_at?: string | null;
  /**
   * Minutes the camera's clock ran ahead of UTC when it recorded an offset
   * (`media_asset.tz_offset_min`). Read by the trip display layer (`trips.ts`)
   * so a trip's calendar days are counted in the camera's zone, the same rule
   * the vault's own trip detection uses — absent for a row whose query does not
   * project the column, and an absent offset is not an offset of zero.
   */
  tz_offset_min?: number | null;
  /**
   * Edit lineage (issue #711): the asset this one was derived from, when it
   * was — the editor saves a crop as a new photograph and stamps the original
   * here. Null/absent on every camera original and every import, and that
   * absence is meaningful: it is the difference between "from a photograph
   * taken in March" and "from an edit", and the viewer says which.
   */
  source_asset_id?: string | null;
  created_at?: string | null;
  width?: number | null;
  height?: number | null;
  duration_s?: number | null;
  album_ids?: string[];
  album_titles?: string[];
  place?: Place | null;
  place_id?: string | null;
  tags?: AssetTag[];
  custody_state?: string | null;
  exif_json?: string | Record<string, unknown> | null;
  purge_at?: string | null;
  purge_in_days?: number | null;
  deleted_at?: string | null;
  [key: string]: unknown;
}

/** One album row (a core.collection projected onto the photo surface). */
export interface Album {
  album_id: string;
  title?: string | null;
  cover_content_id?: string | null;
  count?: number;
  coverUri?: string | null;
}

/** A near-duplicate cluster (queries/duplicates.js). */
export interface DuplicateCluster {
  key: string;
  assets: Asset[];
}

/** One derived Memories card (buildMemories in app.tsx). */
export interface MemoryCard {
  key: string;
  title: string;
  sub: string;
  coverUri: string | null;
  /** The scope the cover's bytes live in (issue #599) — see `Asset.scope_id`. */
  coverScopeId?: string | null;
  newestAt: string;
  onOpen: () => void;
  /**
   * A trip card's route, in capture order — the places the trip passed
   * through, ready for `projectPlaces` (issue #816). Present only on a 'trip'
   * card that had at least one located member; the sketch drawn from it is
   * arithmetic over coordinates the vault already holds, so a card carries a
   * map of the trip with no tile request and no remote URL anywhere in it.
   */
  route?: TripRoutePoint[];
}

/** Vault-derived memory projection rows; clients render but never recompute. */
export interface MemoryRow {
  memory_id: string;
  kind: "on-this-day" | "trip" | "similar";
  title_hint?: string | null;
  day_key?: string | null;
  place_id?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  computed_at?: string | null;
}

export interface MemoryMemberRow {
  memory_id: string;
  asset_id: string;
  ordinal: number;
}

/** One row of the lightbox Details grid (format.js `exifRows`). */
export interface ExifRow {
  label: string;
  value: string;
  // No `href`: the only row that ever carried one was Location, linking out to
  // a public map with the coordinate in the query string. A detail row is a
  // fact, not a departure.
}

/** One honest Activity row (activity.js `buildActivity`). */
export interface ActivityItem {
  text: string;
  date: string;
}

/** Custody projection in owner words + the CSS tone key (format.js). */
export interface CustodyMeta {
  label: string;
  tone: "ok" | "warn" | "danger";
}

/** The shape `queries/library.js` resolves to (page-side `refresh`). */
export interface LibraryData {
  assets?: Asset[];
  albums?: Album[];
  places?: Place[];
  trash?: Asset[];
  memories?: MemoryRow[];
  memoryMembers?: MemoryMemberRow[];
  truncated?: boolean;
  /** The page's oldest `taken_at` — the next `before` cursor (issue #599). */
  tail?: string | null;
  window?: number;
  vaultDenied?: { code?: string; message?: string } | null;
  error?: string;
}
