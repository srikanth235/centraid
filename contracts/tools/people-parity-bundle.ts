// THE PEOPLE PARITY BUNDLE'S SHAPE, and the canonicalisation that makes two
// runs of the generator agree byte for byte (#1020, wave 4 slot 4c).
//
// Split out of `export-people-parity.ts` for the reason Docs' pair records: the
// repository's 625-line ceiling (`oxlint.config.ts`'s `max-lines`, exempted only
// by a ledger row that has to survive a down-only budget — so a split is the
// honest answer and a row is not). The halves are the DATA — what a case, a
// step, a row set and the bundle are, plus the epoch, the table list, the
// canonicaliser and the scenario/handler loaders, plus the two direct writes to
// the database that carry no decisions — and the RUN, which is the seed, the
// scripted command set and the seven handlers.

import type { openVaultDb } from "../../packages/vault/src/db.js";

/** Where the bundle is written, relative to the repository root. */
export const PEOPLE_PARITY_DIR = "contracts/apps/people";

/**
 * The instant the whole run is stamped at. Frozen, and in the far future for
 * the reason Tally's, Photos' and Docs' generators record: the vault has TWO
 * clocks, and a condition comparing `purge_at` against SQLite's own `now`
 * cannot be held still by a JS proxy. `people.restore_person`'s precondition is
 * exactly such a comparison, so at a past epoch the restore step cannot be
 * fixtured at all.
 *
 * The Rust port took the other road: its condition reads `ctx.now`
 * (`crates/vault/src/commands/people.rs`), so the same fixture is reproducible
 * at any instant. The epoch stays in 2099 while v0 is the oracle.
 */
export const PARITY_EPOCH = "2099-06-01T09:00:00.000Z";

/**
 * The vault's zone offset, in minutes, that the civil-time cases are read in.
 *
 * **The birthday rail is a CIVIL-DATE question and v0 answers it in the HOST's
 * zone** (`people/format.ts:53`-`:71`), which is the bug D-1020-PE7 names. The
 * fixture therefore pins the host to UTC while it runs (see the generator's
 * `TZ` note) and records the offset it read, so the Rust side can ask the same
 * question in the same zone and the divergence is a comparison rather than a
 * coincidence.
 */
export const PARITY_ZONE_OFFSET_MINUTES = 0;
export const PARITY_TODAY = "2099-06-01";

/**
 * The tables People's seven queries read, in the order the roster reads them.
 *
 * Derived from the STATEMENTS, not from the manifest's `vault.scopes`: the
 * manifest declares reach and the statements are what ran. `tally_friend` is
 * deliberately absent — `people.add_debt` WRITES it and no query reads it.
 */
export const PEOPLE_PARITY_TABLES = [
  "core_vault",
  "core_party",
  "core_concept_scheme",
  "core_concept",
  "core_tag",
  "core_activity",
  "core_link",
  "core_content_item",
  "core_entity_revision",
  "people_profile",
  "people_important_date",
  "knowledge_note",
  "knowledge_annotation",
  "schedule_task",
  "social_contact_channel",
  "share_party_vault_binding",
  "tally_obligation",
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

export interface PeopleParityBundle {
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
  bundle: PeopleParityBundle
): PeopleParityBundle {
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
  return JSON.parse(canonical) as PeopleParityBundle;
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
 * The ontology scenarios that touch People, exported as data.
 *
 * ONT-23 is the drift this app's money sits on top of — a position keyed by
 * PARTY alone, summed across currencies — which is why the person sheet's debts
 * carry their currency in the Rust port. ONT-26 is the month-day calendar the
 * important-date command and Atlas once disagreed about. ONT-27 is task
 * completion, the drift that took People's own `toggle_task` away.
 *
 * A drift id that no longer exists must FAIL here rather than export one
 * scenario fewer: Photos' generator records an earlier draft asking for a
 * renumbered id and the filter answering quietly with the others.
 */
export async function peopleScenarios(): Promise<unknown> {
  const { buildOntologyScenarios } =
    await import("../../packages/vault/tests/fixtures/ontology-scenarios/build.js");
  const fixture = buildOntologyScenarios();
  try {
    const wanted = new Set(["ONT-23", "ONT-26", "ONT-27"]);
    const scenarios = fixture.scenarios.filter((scenario: { drift: string }) =>
      wanted.has(scenario.drift)
    );
    const found = new Set(
      scenarios.map((scenario: { drift: string }) => scenario.drift)
    );
    const missing = [...wanted].filter((drift) => !found.has(drift));
    if (missing.length > 0) {
      throw new Error(
        `the ontology scenario set carries no ${missing.join(", ")}: the People drifts moved`
      );
    }
    return { digest: fixture.digest, scenarios };
  } finally {
    fixture.db.close();
  }
}

/** The seven handlers, by the name their file carries. */
export async function loadHandlers(): Promise<
  Record<string, (args: unknown) => Promise<unknown>>
> {
  const NAMES = [
    "people",
    "person",
    "dashboard",
    "journal",
    "search",
    "trash",
    "history",
  ] as const;
  // THE SPECIFIERS ARE COMPUTED, NOT LITERAL, for the reason Tally's generator
  // records: a literal import pulls the whole blueprint handler graph into
  // whatever TypeScript program type-checks this file, and no program that can
  // also see `packages/vault/src` has both tsconfigs.
  const modules = await Promise.all(
    NAMES.map(
      (name) =>
        import(`../../packages/blueprints/apps/people/queries/${name}.ts`)
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

/**
 * The sharing plane, written directly rather than through a command: v0 has no
 * command that mints a `share_party_vault_binding`, and the roster's `linked`
 * chip is read off one.
 *
 * **AT MOST ONE LIVE BINDING PER PARTY** — `share_party_vault_binding` carries
 * a partial unique index, `…_live_party ON (party_id) WHERE revoked_at IS NULL`
 * — so the roster's `vault_count`, which is a COUNT over live bindings, is 0 or
 * 1 and never more. `linked` and `vault_count` therefore carry exactly the same
 * information (finding PE-F6).
 *
 * Three shapes, which is every shape the read has: a live binding, a party
 * whose ONLY binding is revoked (so a row exists and `linked` is still false —
 * the read's own `revoked_at IS NULL` filter, not the fold's), and a party with
 * a revoked binding beside a live one.
 */
export function seedSharePlane(
  vault: ReturnType<typeof openVaultDb>["vault"],
  parties: readonly string[]
): void {
  const at = PARITY_EPOCH;
  const bindings: readonly [string, number, string, string | null][] = [
    ["binding-live-a", 0, "vault-alvarez", null],
    ["binding-old-a", 0, "vault-alvarez-old", at],
    ["binding-live-b", 1, "vault-ray", null],
    ["binding-revoked-c", 2, "vault-bennett", at],
  ];
  for (const [bindingId, index, vaultId, revokedAt] of bindings) {
    const partyId = parties[index];
    if (partyId === undefined) continue;
    vault
      .prepare(
        `INSERT INTO share_party_vault_binding
           (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
         VALUES (?, ?, ?, NULL, ?, ?)`
      )
      .run(bindingId, partyId, vaultId, at, revokedAt);
  }
}

/**
 * Dump every table the bundle carries, column order and all, read off the live
 * schema rather than a hand-kept list — so a column added to the DDL reaches
 * the fixture and the port's comparison without anybody remembering it.
 */
export function dumpTables(
  vault: ReturnType<typeof openVaultDb>["vault"]
): TableRows[] {
  return PEOPLE_PARITY_TABLES.map((table) => {
    const columns = (
      vault.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
      }[]
    ).map((column) => column.name);
    const fetched = vault
      .prepare(
        `SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${columns[0]}`
      )
      .all() as Record<string, string | number | null>[];
    return {
      table,
      columns,
      rows: fetched.map((row) =>
        columns.map((column) => {
          const cell: unknown = row[column];
          // A BLOB reaches here as a Uint8Array. THE FIXTURE CARRIES NO
          // BYTES: `sha256` and `byte_size` are what a port compares.
          if (cell instanceof Uint8Array) return null;
          return (cell ?? null) as string | number | null;
        })
      ),
    };
  });
}
