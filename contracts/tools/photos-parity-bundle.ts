// THE PHOTOS PARITY BUNDLE'S SHAPE, and the canonicalisation that makes two
// runs of the generator agree byte for byte (#1020, wave 4 lane Photos).
//
// Split out of `export-photos-parity.ts` because that file reached the
// repository's 625-line ceiling; the halves are the DATA (what a case, a row
// set and the bundle are, plus the epoch and the table list) and the RUN (the
// seed, the scripted command set, the sweeps and the eight handlers).

export const PHOTOS_PARITY_DIR = "contracts/apps/photos";

/**
 * The instant the whole run is stamped at. Frozen, and in the far future for
 * the reason Tally's generator records: the vault has TWO clocks, and a
 * condition comparing `purge_at` against SQLite's own `now` cannot be held
 * still by a JS proxy. `media.restore_asset`'s precondition is exactly such a
 * comparison (`packages/vault/src/commands/media.ts`'s `asset_is_trashed`), so
 * at a past epoch the restore step cannot be fixtured at all.
 *
 * The Rust port took the other road: its condition reads `:ctx_now`
 * (`crates/vault/src/commands/media.rs`), so the same fixture is reproducible
 * at any instant. The epoch stays in 2099 while v0 is the oracle.
 */
export const PARITY_EPOCH = "2099-06-01T09:00:00.000Z";

/**
 * The tables the eight Photos queries read, in the order the library reads
 * them.
 *
 * Derived from the STATEMENTS, not from the manifest's `vault.scopes`: the
 * manifest declares reach and the statements are what ran.
 */
export const PHOTOS_PARITY_TABLES = [
  "core_vault",
  "core_party",
  "core_content_item",
  "core_content_representation",
  "core_content_derivative",
  "core_concept_scheme",
  "core_concept",
  "core_tag",
  "core_collection",
  "core_collection_entry",
  "core_place",
  "media_asset",
  "media_asset_phash",
  "media_face_region",
  "media_face_cluster",
  "media_memory",
  "media_memory_member",
  "enrich_policy",
  "enrich_request",
  "blob_custody_state",
  "blob_custody_rollup",
] as const;

/** One table's rows, as data. */
export interface TableRows {
  table: string;
  columns: string[];
  rows: (string | number | null)[][];
}

export interface QueryCase {
  query: string;
  input: Record<string, unknown>;
  output: unknown;
  /**
   * Present only on the ONE case read before the sweeps ran.
   *
   * `rows.json` is the state every other case was read from, and a sweep
   * changes that state — so the bundle describes ONE vault, swept, and the
   * "not counted yet" storage answer is marked rather than silently
   * contradicting the rows next to it (D-1020-P1).
   */
  phase?: "unswept";
}

export interface CommandCase {
  command: string;
  input: Record<string, unknown>;
  status: string;
  output: unknown;
  reason?: string;
}

export interface PhotosParityBundle {
  rows: TableRows[];
  queries: QueryCase[];
  commands: CommandCase[];
  scenarios: unknown;
}

/**
 * How far from `PARITY_EPOCH` an instant may sit and still count as the
 * FIXTURE's own time rather than the host's.
 *
 * The seed dates its roll by subtracting days from the injected `now`, so every
 * instant the fixture owns lands within weeks of the epoch; anything else —
 * SQLite's own `created_at`/`updated_at` defaults, which no JS clock proxy can
 * hold still, and the ontology-scenario fixture's own database — is the host's,
 * is different on every machine, and is the thing a token exists for.
 *
 * An earlier draft of this generator wrote the rule as a negative LOOKBEHIND,
 * `/(?<!2099)\b(?:19|20)\d{2}-…/`, meaning to spare the epoch. It spares
 * nothing: the lookbehind inspects the four characters BEFORE the match, which
 * for `"2099-06-01T…"` are a quote and a colon, never `2099`. Every
 * deterministic instant in the bundle was therefore replaced — `captured_at`
 * included — which silently deleted the ordering the library query is ABOUT
 * and the capture time the face queue dates a proposal by. A range on the
 * parsed value cannot be got wrong in that direction, and it says what it
 * means.
 */
export const FIXTURE_INSTANT_WINDOW_MS = 400 * 24 * 60 * 60 * 1000;

/** The token every host-clock instant is replaced by. */
const HOST_CLOCK = "(host-clock)";

/**
 * Canonicalise the WHOLE bundle in one pass: every identifier to the order it
 * first appears, every host-clock instant to an ordered token.
 *
 * ONE PASS, NOT FOUR. The four files describe one vault: `rows.json` is the
 * state the cases in `queries.json` were read from. Canonicalised separately,
 * `id-0027` would name one thing in one file and another in the next, and the
 * Rust parity test — which builds its vault FROM the rows and then compares the
 * ported queries' answers to v0's, ids included
 * (`crates/apps/photos/tests/parity.rs`) — could not be written at all.
 *
 * THE HOST-CLOCK TOKEN IS PARENTHESISED, AND THAT IS LOAD-BEARING. Three of
 * the seed's assets carry no `captured_at`, so the library's `taken_at` falls
 * back to `created_at` — which is SQLite's, not the injected clock's — and
 * `taken_at` is the column the grid ORDERS BY. `(` sorts BELOW every digit
 * under SQLite's BINARY collation, so a tokenised instant still sorts where the
 * real one did: the host clock is below the 2099 epoch, and an undated asset
 * still rides the end of a newest-first page. An angle-bracketed token, `<`,
 * sorts ABOVE the digits and would have moved those assets to the FRONT of
 * every page a port serves from these rows.
 *
 * The token carries no ordering AMONG host instants, and that is deliberate
 * rather than lossy: numbering them chronologically was tried and is not
 * idempotent — two rows share a millisecond in one run and not the next, so
 * the distinct count moves and every later number shifts. What is left is a
 * tie the reading statement breaks on its primary key, which is a UUIDv7 and
 * therefore already in creation order. `crates/apps/photos/tests/parity.rs`
 * compares the ported page against v0's answer ORDER INCLUDED, so that claim
 * is proved rather than assumed.
 */
export function canonicaliseBundle(
  bundle: PhotosParityBundle
): PhotosParityBundle {
  const ID =
    /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})\b/giu;
  const INSTANT =
    /\b(?:19|20)\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu;
  const epoch = Date.parse(PARITY_EPOCH);
  const hostInstant = (instant: string): boolean =>
    Math.abs(Date.parse(instant) - epoch) > FIXTURE_INSTANT_WINDOW_MS;

  // ROWS FIRST in the key order, so an id's number follows the vault's own
  // tables rather than whichever query happened to read the thing first.
  const text = JSON.stringify({
    rows: bundle.rows,
    queries: bundle.queries,
    commands: bundle.commands,
    scenarios: bundle.scenarios,
  });

  const ids = new Map<string, string>();
  // A 64-hex sha is NOT canonicalised: it is a fact about the bytes, it is
  // reproducible, and a port compares it. The id pattern above cannot match it
  // because it is anchored to 32 hex characters exactly.
  const canonical = text
    .replaceAll(ID, (id) => {
      const known = ids.get(id.toLowerCase());
      if (known) return known;
      const token = `id-${String(ids.size + 1).padStart(4, "0")}`;
      ids.set(id.toLowerCase(), token);
      return token;
    })
    .replaceAll(INSTANT, (instant) =>
      hostInstant(instant) ? HOST_CLOCK : instant
    );
  return JSON.parse(canonical) as PhotosParityBundle;
}

/** Deep-sorted JSON, so two runs that agree on values agree on bytes. */
export function stableJson(value: unknown): string {
  const sorted = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sorted);
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, child]) => [key, sorted(child)])
      );
    }
    return node;
  };
  return `${JSON.stringify(sorted(value), null, 2)}\n`;
}
