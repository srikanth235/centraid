// THE DOCS PARITY BUNDLE'S SHAPE, and the canonicalisation that makes two runs
// of the generator agree byte for byte (#1020, wave 4 slot 4b).
//
// Split out of `export-docs-parity.ts` because that file reached the
// repository's 625-line ceiling (`oxlint.config.ts`'s `max-lines`, exempted
// only by a ledger row that has to survive a down-only budget — so a split is
// the honest answer and a row is not). The halves are the DATA — what a case, a
// step, a row set and the bundle are, plus the epoch, the table list, the
// canonicaliser and the scenario/handler loaders — and the RUN, which is the
// seed, the scripted command set, the share plane and the four handlers.

/** Where the bundle is written, relative to the repository root. */
export const DOCS_PARITY_DIR = "contracts/apps/docs";

/**
 * The instant the whole run is stamped at. Frozen, and in the far future for the
 * reason Tally's and Photos' generators record: the vault has TWO clocks, and a
 * condition comparing `purge_at` against SQLite's own `now` cannot be held still
 * by a JS proxy. `core.restore_document`'s precondition is exactly such a
 * comparison, so at a past epoch the restore step cannot be fixtured at all.
 *
 * The Rust port took the other road: its condition reads `:ctx_now`
 * (`crates/vault/src/commands/core.rs`), so the same fixture is reproducible at
 * any instant. The epoch stays in 2099 while v0 is the oracle.
 */
export const PARITY_EPOCH = "2099-06-01T09:00:00.000Z";

/**
 * The tables the four Docs queries read, in the order the drive reads them.
 *
 * Derived from the STATEMENTS, not from the manifest's `vault.scopes`: the
 * manifest declares reach and the statements are what ran.
 */
export const DOCS_PARITY_TABLES = [
  "core_vault",
  "core_party",
  "core_concept_scheme",
  "core_concept",
  "core_tag",
  "core_document",
  "core_content_item",
  "core_content_text",
  "core_content_representation",
  "core_content_derivative",
  "core_entity_revision",
  "access_provenance",
  "blob_custody_state",
  "share_authority",
  "share_fulfillment",
  "share_party_vault_binding",
  "share_subscription",
  "share_subscription_lineage",
  "social_circle",
  "social_circle_member",
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
}

/**
 * One step of the replayable script.
 *
 * `input` carries `{"$from": "<step>.<key>"}` where the run used an id a step
 * before it minted, so a Rust replay resolves the reference against ITS OWN
 * outputs. `output_keys` is what the step must answer for a later reference to
 * resolve — asserted on the replay side, so a port that dropped an output key
 * fails loudly rather than at the reference.
 */
export interface CommandStep {
  command: string;
  input: Record<string, unknown>;
  output_keys: string[];
  status: string;
  /** The owner-facing sentence, on a step that is a refusal on purpose. */
  reason?: string;
}

export interface DocsParityBundle {
  rows: TableRows[];
  queries: QueryCase[];
  commands: CommandStep[];
  scenarios: unknown;
}

/**
 * How far from [`PARITY_EPOCH`] an instant may sit and still count as the
 * FIXTURE's own time rather than the host's.
 *
 * Photos' generator records the reasoning in full: SQLite's own
 * `created_at`/`updated_at` defaults are the host's, are different on every
 * machine, and are the thing a token exists for. A range on the parsed value
 * cannot be got wrong the way a negative lookbehind can.
 */
export const FIXTURE_INSTANT_WINDOW_MS = 400 * 24 * 60 * 60 * 1000;

/** The token every host-clock instant is replaced by. */
const HOST_CLOCK = "(host-clock)";

/**
 * Canonicalise the WHOLE bundle in one pass: every identifier to the order it
 * first appears, every host-clock instant to an ordered token.
 *
 * ONE PASS, NOT FOUR. The files describe one vault: `rows.json` is the state the
 * cases in `queries.json` were read from. Canonicalised separately, `id-0027`
 * would name one thing in one file and another in the next, and the Rust parity
 * test — which builds its vault FROM the rows and then compares the ported
 * queries' answers to v0's, ids included — could not be written at all.
 *
 * THE HOST-CLOCK TOKEN IS PARENTHESISED, AND THAT IS LOAD-BEARING. `(` sorts
 * BELOW every digit under SQLite's BINARY collation, so a tokenised instant
 * still sorts where the real one did. An angle-bracketed token would sort ABOVE
 * the digits and move those rows to the front of every newest-first page.
 */
export function canonicaliseBundle(bundle: DocsParityBundle): DocsParityBundle {
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
  // reproducible, and a port compares it. The id pattern cannot match it
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
  return JSON.parse(canonical) as DocsParityBundle;
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

/**
 * The ontology scenarios that touch a document, exported as data.
 *
 * ONT-22 is the one this app exists on top of: two byte-identical files keep
 * separate histories, which is what stops one member's document becoming
 * another's. ONT-26 is the sha's shape, and ONT-28 is one byte row read two
 * ways — WHY a media type is a property of the owner and not of the bytes.
 *
 * A drift id that no longer exists must FAIL here rather than export one
 * scenario fewer: Photos' generator records an earlier draft asking for a
 * renumbered id and the filter answering quietly with the others.
 */
export async function documentScenarios(): Promise<unknown> {
  const { buildOntologyScenarios } =
    await import("../../packages/vault/tests/fixtures/ontology-scenarios/build.js");
  const fixture = buildOntologyScenarios();
  try {
    const wanted = new Set(["ONT-22", "ONT-26", "ONT-28"]);
    const scenarios = fixture.scenarios.filter((scenario: { drift: string }) =>
      wanted.has(scenario.drift)
    );
    const found = new Set(
      scenarios.map((scenario: { drift: string }) => scenario.drift)
    );
    const missing = [...wanted].filter((drift) => !found.has(drift));
    if (missing.length > 0) {
      throw new Error(
        `the ontology scenario set carries no ${missing.join(", ")}: the document drifts moved`
      );
    }
    return { digest: fixture.digest, scenarios };
  } finally {
    fixture.db.close();
  }
}

/** The four handlers, by the name their file carries. */
export async function loadHandlers(): Promise<
  Record<string, (args: unknown) => Promise<unknown>>
> {
  const NAMES = ["drive", "search", "history", "activity"] as const;
  // THE SPECIFIERS ARE COMPUTED, NOT LITERAL, for the reason Tally's generator
  // records: a literal import pulls the whole blueprint handler graph into
  // whatever TypeScript program type-checks this file, and no program that can
  // also see `packages/vault/src` has both tsconfigs.
  const modules = await Promise.all(
    NAMES.map(
      (name) => import(`../../packages/blueprints/apps/docs/queries/${name}.ts`)
    )
  );
  return Object.fromEntries(
    NAMES.map((name, index) => [
      name,
      (modules[index] as { default: unknown }).default as (
        args: unknown
      ) => Promise<unknown>,
    ])
  );
}
