// THE NOTES PARITY BUNDLE'S SHAPE, and the canonicalisation that makes two runs
// of the generator agree byte for byte (#1020, wave 4 slot 4c).
//
// Split out of `export-notes-parity.ts` because that file reaches the
// repository's 625-line ceiling (`oxlint.config.ts`'s `max-lines`, exempted only
// by a ledger row that has to survive a down-only budget — so a split is the
// honest answer and a row is not). The halves are the DATA — what a case, a
// step, a row set and the bundle are, plus the epoch, the table list, the
// canonicaliser and the loaders — and the RUN, which is the seed, the scripted
// command set, the journal marker and the six handlers.

/** Where the bundle is written, relative to the repository root. */
export const NOTES_PARITY_DIR = "contracts/apps/notes";

/**
 * The instant the whole run is stamped at. Frozen, and in the far future for the
 * reason Docs', Tally's and Photos' generators record: the vault has TWO clocks,
 * and a condition comparing `purge_at` against SQLite's own `now` cannot be held
 * still by a JS proxy. `knowledge.restore_note`'s precondition is exactly such a
 * comparison, so at a past epoch the restore step cannot be fixtured at all.
 *
 * The Rust port took the other road: its condition reads `ctx.now`
 * (`crates/vault/src/commands/knowledge.rs`), so the same fixture is reproducible
 * at any instant. The epoch stays in 2099 while v0 is the oracle.
 */
export const PARITY_EPOCH = "2099-06-01T09:00:00.000Z";

/**
 * The tables the six Notes queries and the card resolver read, in the order the
 * library reads them.
 *
 * Derived from the STATEMENTS, not from the manifest's `vault.scopes`: the
 * manifest declares reach and the statements are what ran. The five domain
 * tables at the end are the powerbox's and the card resolver's — empty in this
 * corpus, and exported anyway, because "the Rust side builds its vault from
 * these rows" is only true if the list is the whole list.
 */
export const NOTES_PARITY_TABLES = [
  "core_vault",
  "core_party",
  "core_concept_scheme",
  "core_concept",
  "core_tag",
  "core_collection",
  "core_collection_entry",
  "knowledge_note",
  "core_content_item",
  "core_content_text",
  "core_content_representation",
  "core_entity_revision",
  "core_attachment",
  "core_link",
  "core_link_anchor",
  "core_document",
  "core_event",
  "media_asset",
  "schedule_task",
  "tally_expense",
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
 *
 * `pending` names a schema whose commands are not in the Rust build yet: the
 * Agenda/Tasks lane holds `schedule` (slot 4d), and `send-to-tasks` invokes
 * `schedule.add_task`. The step is recorded from v0 either way and the Rust
 * replay skips it, so the case lands the moment 4d does.
 */
export interface CommandStep {
  command: string;
  input: Record<string, unknown>;
  output_keys: string[];
  status: string;
  /** The owner-facing sentence, on a step that is a refusal on purpose. */
  reason?: string;
  /** The schema this build does not carry. */
  pending?: string;
}

export interface NotesParityBundle {
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
export function canonicaliseBundle(
  bundle: NotesParityBundle
): NotesParityBundle {
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
  return JSON.parse(canonical) as NotesParityBundle;
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
 * The ontology scenarios that touch a note, exported as data.
 *
 * ONT-22 is the one this app exists on top of — document and note history was a
 * content→content graph beside `core_entity_revision`, which is what
 * `contracts/migrations/002_revisions.sql` proposes to close on STORAGE. ONT-28
 * is one byte row read two ways, which is why two notes with identical words and
 * different formats keep their own media types.
 *
 * A drift id that no longer exists must FAIL here rather than export one
 * scenario fewer: Photos' generator records an earlier draft asking for a
 * renumbered id and the filter answering quietly with the others.
 */
export async function noteScenarios(): Promise<unknown> {
  const { buildOntologyScenarios } =
    await import("../../packages/vault/tests/fixtures/ontology-scenarios/build.js");
  const fixture = buildOntologyScenarios();
  try {
    const wanted = new Set(["ONT-22", "ONT-28"]);
    const scenarios = fixture.scenarios.filter((scenario: { drift: string }) =>
      wanted.has(scenario.drift)
    );
    const found = new Set(
      scenarios.map((scenario: { drift: string }) => scenario.drift)
    );
    const missing = [...wanted].filter((drift) => !found.has(drift));
    if (missing.length > 0) {
      throw new Error(
        `the ontology scenario set carries no ${missing.join(", ")}: the note drifts moved`
      );
    }
    return { digest: fixture.digest, scenarios };
  } finally {
    fixture.db.close();
  }
}

/** The six handlers, by the name the manifest gives each one. */
export async function loadHandlers(): Promise<
  Record<string, (args: unknown) => Promise<unknown>>
> {
  const NAMES = [
    "library",
    "note",
    "search",
    "history",
    "journal",
    "link-targets",
  ] as const;
  // THE SPECIFIERS ARE COMPUTED, NOT LITERAL, for the reason Tally's generator
  // records: a literal import pulls the whole blueprint handler graph into
  // whatever TypeScript program type-checks this file, and no program that can
  // also see `packages/vault/src` has both tsconfigs.
  const modules = await Promise.all(
    NAMES.map(
      (name) =>
        import(`../../packages/blueprints/apps/notes/queries/${name}.ts`)
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
