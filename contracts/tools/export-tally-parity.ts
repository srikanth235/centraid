// Export Tally's parity fixtures from the v0 tree (#1020, wave 2 lane D3,
// D-1020-D3-6).
//
// WHY GENERATED AND NOT TYPED. v0 is the executable specification. A parity
// fixture typed by hand is a fixture that says what its author believed the
// handlers do; this one says what they do. So the generator founds a fresh v0
// vault, runs a scripted ledger through the REAL typed vault commands, then
// invokes every Tally query through the real handler path — the same
// statement-as-data through the same paged door — and writes what came back.
//
// WHAT IT WRITES, under `contracts/apps/tally/`:
//
//   rows.json       every row of every table the eight queries read, by table
//   queries.json    {query, input, output} for all eight, at fixed inputs
//   balances.json   the balance engine's cases: inputs -> pairwise/simplified
//   scenarios.json  the two ontology scenarios that touch tally (ONT-23, ONT-24)
//
// WHY ROWS AND NOT A `vault.db.gz` (D-1020-D3-11). The brief asked for a
// compressed fixture vault. Three facts make rows the better artifact and the
// `.db.gz` an impossible one:
//
//   1. `bootstrapVault` mints the vault, the owner party and the first device as
//      UUIDv7 off the clock. They are NOT seed-derived (stated at
//      `packages/vault/tests/fixtures/ontology-scenarios/build.ts:70-79`), so a
//      database file is not byte-reproducible and `git diff --exit-code
//      contracts/apps` — the gate that the fixture is current — could never pass.
//   2. A compressed database is not reviewable. `contracts/README.md`'s rule is
//      that a fixture is data both trees read "without a bridge"; a diff nobody
//      can read is a fixture nobody checks.
//   3. Rust needs a schema to open anyway, and `contracts/schema/vault-ddl.sql`
//      already IS that schema. Rows plus the committed DDL reconstruct the same
//      file on either side, and the DDL stays the one copy.
//
// So every identifier is canonicalised to the order it first appears in —
// `#1`, `#2`, … — which is the same technique and the same reason as
// `stableDigest` in the ontology-scenario builder: "the same rows, in the same
// order, related the same way" is the property a convergence test wants.
// After canonicalisation the whole bundle is byte-stable across runs.
//
// REGENERATE (needs `bun run build` once in a fresh worktree for dist
// resolution; the runner is NODE, not bun, because v0's vault imports
// `node:sqlite`, which bun does not provide):
//
//   node node_modules/vitest/vitest.mjs run --config vitest.quality.config.ts \
//     tests/quality/tally-parity.contract.test.ts
//   bun run format
//
// That test is the fixture's ORACLE as well as its emitter: with
// `CENTRAID_WRITE_CONTRACTS=1` it writes the four files, and without it it
// rebuilds the bundle and asserts byte-equality with what is committed. So "the
// fixture passes in v0 too" is one command rather than a second suite, and the
// check that the fixture is current is `git diff --exit-code contracts/apps`
// after a write run.

import { bootstrapVault } from "../../packages/vault/src/bootstrap.js";
import { registerAttachmentCommands } from "../../packages/vault/src/commands/attachments.js";
import { registerPartyCommands } from "../../packages/vault/src/commands/parties.js";
import { registerScheduleOrganizeCommands } from "../../packages/vault/src/commands/schedule-organize.js";
import { registerScheduleCommands } from "../../packages/vault/src/commands/schedule.js";
import { registerTallyLedgerCommands } from "../../packages/vault/src/commands/tally-ledger.js";
import { registerTallyOrganizeCommands } from "../../packages/vault/src/commands/tally-organize.js";
import { registerTallyCommands } from "../../packages/vault/src/commands/tally.js";
import { openVaultDb } from "../../packages/vault/src/db.js";
import { createGateway } from "../../packages/vault/src/gateway/gateway.js";
import type { Credential } from "../../packages/vault/src/gateway/types.js";
import { installFixtureClock } from "../../packages/vault/tests/fixtures/ontology-scenarios/clock.js";
import { balanceCases } from "./tally-parity-balances.js";
import { seedLedger } from "./tally-parity-ledger.js";

/** Where the bundle is written, relative to the repository root. */
export const TALLY_PARITY_DIR = "contracts/apps/tally";

/**
 * The instant the whole run is stamped at. Frozen, and shared by the vault.
 *
 * **Why it is in 2099, and the v0 finding behind it.** The vault has TWO
 * clocks. A command's handler stamps `ctx.now`, which `installFixtureClock`
 * can hold still because it is JS; a command's pre/postconditions are SQL, and
 * `EXPENSE_TRASHED_SQL` compares `purge_at` against SQLite's own
 * `strftime('%Y-%m-%dT%H:%M:%fZ','now')`
 * (`packages/vault/src/commands/tally.ts:103-105`), which no JS proxy reaches.
 * So with a frozen clock in the past, `tally.delete_expense` writes a
 * `purge_at` that is already expired by the host's reckoning and its own
 * postcondition refuses it — the trash step simply cannot be fixtured at a
 * past instant. An epoch in the far future makes the two clocks agree about
 * every window for as long as the fixture exists, which is the only answer
 * that does not expire. Recorded as a finding: a vault whose conditions read a
 * different clock from its handlers cannot be deterministically fixtured, and
 * `crates/vault` should take its instant from one injected source.
 */
export const PARITY_EPOCH = "2099-06-01T09:00:00.000Z";

/** A `since` floor between the expenses and the settlement. */
const SINCE_FLOOR = "2099-05-10";

/**
 * The tables the eight Tally queries read, in the order `loadTally` reads them.
 *
 * Derived from the statements themselves (#1020 apps §3.2), not from the
 * manifest's `vault.scopes`: the manifest is a declaration of reach and the
 * statements are what ran.
 */
export const TALLY_PARITY_TABLES = [
  "core_vault",
  "core_party",
  "core_attachment",
  "core_content_item",
  "core_content_representation",
  "core_entity_revision",
  "core_transaction",
  "core_account",
  "core_link",
  "social_circle",
  "social_circle_member",
  "schedule_recurrence_exception",
  "tally_friend",
  "tally_group",
  "tally_expense",
  "tally_expense_split",
  "tally_expense_payer",
  "tally_expense_line_item",
  "tally_expense_line_allocation",
  "tally_settlement",
  "tally_obligation",
  "tally_nudge",
  "tally_recurring_expense",
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

export type { BalanceCase, BalanceInput } from "./tally-parity-balances.js";

export interface TallyParityBundle {
  rows: TableRows[];
  queries: QueryCase[];
  balances: import("./tally-parity-balances.ts").BalanceCase[];
  scenarios: unknown;
}

/**
 * The token every host-clock instant is replaced by.
 *
 * THE SECOND HALF OF THE TWO-CLOCKS FINDING (see [`PARITY_EPOCH`]). Every
 * replicated table carries `updated_at TEXT NOT NULL DEFAULT
 * (strftime('%Y-%m-%dT%H:%M:%fZ','now'))` and a trigger that re-stamps it the
 * same way (`packages/vault/src/schema/updated-at.ts:2`, `:8-16`). That is
 * SQLite's clock, which no JS proxy reaches, so `updated_at` is the wall time
 * of whoever regenerated the fixture and can never be committed as a value.
 * Replacing it with a token says exactly that, and keeps the column's PRESENCE
 * — which is what a port has to reproduce — while dropping a value that is not
 * a fact about the ledger. `crates/vault` taking its instant from one injected
 * source removes both halves of this.
 */
const HOST_CLOCK = "<host-clock>";

/**
 * Canonicalise every identifier to the order it first appears, and every
 * host-clock instant to one token.
 *
 * Two id shapes reach a fixture: UUIDv7 from the bootstrap (not seed-derived)
 * and the command-minted ids, which ARE seed-derived and reproducible. Both are
 * canonicalised anyway, because a fixture that is stable only for half its ids
 * is a fixture whose diff nobody trusts.
 */
/**
 * ONE ID SPACE PER VAULT (#1020, wave 4 lane Tally-finish).
 *
 * THE BUG THIS FIXES, and it made the fixture uncomparable. `canonicalise` held
 * its `seen` map in its own body, so each call started numbering at `id-0001`
 * — and it was called once for `rows` and once for `queries`. The same expense
 * was therefore `id-0035` in `rows.json` and `id-0016` in `queries.json`, and
 * `export`'s own inputs named group ids that no row in `rows.json` carried. A
 * port that rebuilds the vault from the rows and runs the queries could not
 * compare a single case: every id disagreed, and the disagreement was an
 * artifact of the generator rather than a fact about either side.
 *
 * The map is now created once per VAULT and shared by every artifact read out
 * of it. The ontology scenarios get their own, because they are built from a
 * DIFFERENT vault (`buildOntologyScenarios`) and sharing a numbering across two
 * vaults would assert a relationship that does not exist.
 */
function canonicaliser(): <T>(value: T) => T {
  const seen = new Map<string, string>();
  return <T>(value: T): T => canonicaliseWith(value, seen);
}

function canonicaliseWith<T>(value: T, seen: Map<string, string>): T {
  const ID =
    /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})\b/giu;
  // Any instant outside the frozen run's own year. The run is stamped in 2099
  // precisely so that "not ours" is decidable by inspection rather than by a
  // range check nobody can read.
  const HOST_INSTANT =
    /(?<!2099)\b(?:19|20)\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu;
  const text = JSON.stringify(value)
    .replaceAll(ID, (id) => {
      const known = seen.get(id.toLowerCase());
      if (known) return known;
      const token = `id-${String(seen.size + 1).padStart(4, "0")}`;
      seen.set(id.toLowerCase(), token);
      return token;
    })
    .replaceAll(HOST_INSTANT, HOST_CLOCK);
  return JSON.parse(text) as T;
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

/** The eight queries, each at the inputs a parity run compares. */
async function runQueries(
  ctx: unknown,
  ids: { groups: string[]; expenses: string[]; friends: string[] }
): Promise<QueryCase[]> {
  // THE SPECIFIERS ARE COMPUTED, NOT LITERAL, AND THAT IS DELIBERATE.
  //
  // A literal `import("../../packages/blueprints/apps/tally/queries/dashboard.ts")`
  // pulls the whole blueprint handler graph into whatever TypeScript program
  // type-checks this file — and those handlers are written against the
  // blueprints package's own tsconfig, with `allowImportingTsExtensions` and
  // the ambient `HandlerArgs` global. No program that can also see
  // `packages/vault/src` has both. Rather than relax a tsconfig so a generator
  // can be type-checked against a world it only invokes, the specifiers are
  // built at run time: the handlers are the THING UNDER TEST, and a fixture
  // generator asserts on their output rather than on their types.
  const HANDLERS = [
    "dashboard",
    "group",
    "friend",
    "activity",
    "search",
    "history",
    "export",
    "matches",
  ] as const;
  const handlers = await Promise.all(
    HANDLERS.map(
      (name) =>
        import(`../../packages/blueprints/apps/tally/queries/${name}.ts`)
    )
  );
  const [
    dashboard,
    group,
    friend,
    activity,
    search,
    history,
    exporter,
    matches,
  ] = handlers.map(
    (module: { default: unknown }) =>
      module.default as (args: unknown) => Promise<unknown>
  );

  // Inputs are FIXED and named, never derived at compare time: a parity case
  // whose input moves with the fixture is a case that can pass by agreeing
  // about nothing.
  const plan: {
    query: string;
    run: (args: unknown) => Promise<unknown>;
    input: Record<string, unknown>;
  }[] = [
    { query: "dashboard", run: dashboard!, input: {} },
    { query: "activity", run: activity!, input: {} },
    { query: "matches", run: matches!, input: {} },
    { query: "search", run: search!, input: { term: "bo" } },
    { query: "search", run: search!, input: { term: "ramen" } },
    // A term nothing matches: the empty answer is a state, not an error.
    { query: "search", run: search!, input: { term: "zzzz" } },
    ...ids.groups.flatMap((groupId) => [
      { query: "group", run: group!, input: { group_id: groupId } },
      {
        query: "export",
        run: exporter!,
        input: { group_id: groupId, limit: 2_000 },
      },
      {
        query: "export",
        run: exporter!,
        // A `since` floor that excludes the settlement, keeps the expenses.
        input: { group_id: groupId, since: SINCE_FLOOR, limit: 2_000 },
      },
      {
        query: "export",
        run: exporter!,
        // A malformed bound must not narrow a ledger (#1020 apps seam 5).
        input: { group_id: groupId, since: "not-a-date", limit: 2_000 },
      },
    ]),
    // A group that does not exist: `group` answers a null group, never a throw.
    { query: "group", run: group!, input: { group_id: "no-such-group" } },
    ...ids.friends.map((partyId) => ({
      query: "friend",
      run: friend!,
      input: { party_id: partyId },
    })),
    ...ids.expenses.map((expenseId) => ({
      query: "history",
      run: history!,
      input: { expense_id: expenseId },
    })),
  ];

  const cases: QueryCase[] = [];
  for (const entry of plan) {
    // Sequential on purpose: the statements a handler makes are recorded in
    // order, and two handlers in flight would interleave them.
    // eslint-disable-next-line no-await-in-loop
    const output = await entry.run({ ctx, input: entry.input });
    cases.push({ query: entry.query, input: entry.input, output });
  }
  return cases;
}

/**
 * The ontology scenarios that touch tally, exported as data.
 *
 * The fixture is already language-neutral by design: a builder runs the REAL
 * commands against a fresh vault on a repeating clock and hands back every
 * claim already read through the path a surface reads it through
 * (`packages/vault/tests/fixtures/ontology-scenarios/README.md:1`, `:19`). All
 * thirteen run against one vault in order, because a scenario that only holds
 * in an otherwise-empty vault is not telling the truth about the product — so
 * the whole set is built and only the tally rows are exported.
 */
async function tallyScenarios(): Promise<unknown> {
  const { buildOntologyScenarios } =
    await import("../../packages/vault/tests/fixtures/ontology-scenarios/build.js");
  const fixture = buildOntologyScenarios();
  try {
    const wanted = new Set(["ONT-23", "ONT-24"]);
    return {
      // The digest of the WHOLE run, so a replay that agrees about the tally
      // rows but disagrees about the vault they ran in is still caught.
      digest: fixture.digest,
      scenarios: fixture.scenarios.filter((scenario) =>
        wanted.has(scenario.drift)
      ),
    };
  } finally {
    fixture.db.close();
  }
}

/** Build the whole bundle. Opens and closes its own vault. */
export async function buildTallyParity(): Promise<TallyParityBundle> {
  const scenarios = await tallyScenarios();
  // ONE id space for everything read out of the fixture vault: the rows and
  // the query answers have to name the same expense by the same token.
  const vaultIds = canonicaliser();
  const db = openVaultDb();
  const clock = installFixtureClock(PARITY_EPOCH);
  try {
    const boot = bootstrapVault(db, {
      ownerName: "Priya",
      baseCurrency: "GBP",
    });
    const gateway = createGateway(db);
    registerPartyCommands(gateway);
    registerAttachmentCommands(gateway);
    registerScheduleCommands(gateway);
    registerScheduleOrganizeCommands(gateway);
    registerTallyCommands(gateway);
    registerTallyLedgerCommands(gateway);
    registerTallyOrganizeCommands(gateway);
    const owner: Credential = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };

    let step = 0;
    const execute = <T>(command: string, input: Record<string, unknown>): T => {
      // A seed per STEP: the id sequence restarts inside each invocation, so
      // one seed for the whole run would mint the same ids twice.
      const outcome = gateway.invoke(
        owner,
        { command, input },
        `tally-parity:${step++}`
      );
      if (outcome.status !== "executed") {
        // `reason` is on some arms of the outcome union and not others, so it
        // is read off the value rather than off the type: a generator that
        // cannot name why a command refused is a generator nobody can debug.
        const why = (outcome as { reason?: string; message?: string }).reason;
        const detail =
          why ?? (outcome as { message?: string }).message ?? "no reason given";
        throw new Error(`${command} answered ${outcome.status}: ${detail}`);
      }
      // Time moves between commands, or two writes share an instant and every
      // ordering claim over them says nothing.
      clock.advance(1_000);
      return outcome.output as T;
    };

    seedLedger(execute, boot.ownerPartyId);

    const rows: TableRows[] = TALLY_PARITY_TABLES.map((table) => {
      const columns = (
        db.vault.prepare(`PRAGMA table_info(${table})`).all() as {
          name: string;
        }[]
      ).map((column) => column.name);
      const fetched = db.vault
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
            // A BLOB reaches here as a Uint8Array. The fixture carries no
            // bytes: Tally is a record-only app (docs/blueprint-seats.md S2),
            // and a byte-bearing fixture belongs to the media lane.
            if (cell instanceof Uint8Array) return null;
            return (cell ?? null) as string | number | null;
          })
        ),
      };
    });

    const ctx = {
      vault: {
        page: (request: {
          query: Parameters<typeof gateway.page>[1];
          limit: number;
          after?: { sortKey: string; pk: string };
        }) =>
          Promise.resolve(
            gateway.page(owner, request.query, {
              limit: request.limit,
              ...(request.after ? { after: request.after } : {}),
            })
          ),
        invoke: (request: {
          command: string;
          input?: Record<string, unknown>;
        }) =>
          Promise.resolve(
            gateway.invoke(owner, {
              command: request.command,
              input: request.input ?? {},
            })
          ),
      },
      time: await timeApi(),
    };

    const groupIds = (
      db.vault
        .prepare("SELECT group_id FROM tally_group ORDER BY group_id")
        .all() as { group_id: string }[]
    ).map((row) => row.group_id);
    const friendIds = (
      db.vault
        .prepare("SELECT party_id FROM tally_friend ORDER BY party_id")
        .all() as { party_id: string }[]
    ).map((row) => row.party_id);
    const expenseIds = (
      db.vault
        .prepare("SELECT expense_id FROM tally_expense ORDER BY expense_id")
        .all() as { expense_id: string }[]
    ).map((row) => row.expense_id);

    const queries = await runQueries(ctx, {
      groups: groupIds,
      friends: friendIds,
      expenses: expenseIds,
    });

    return {
      // Only the vault-derived halves are canonicalised: they carry UUIDv7
      // bootstrap ids and seed-derived command ids. The balance cases name
      // their parties `me`, `a`, `b` — synthetic on purpose, so the fold's
      // own cases read as arithmetic rather than as a vault.
      rows: vaultIds(rows),
      queries: vaultIds(queries),
      balances: balanceCases(),
      // Its own id space: a different vault (see `canonicaliser`).
      scenarios: canonicaliser()(scenarios),
    };
  } finally {
    clock.restore();
    db.close();
  }
}

/**
 * `ctx.time`, mounted rather than imported.
 *
 * v0 mounts the civil-time capability by URL and every verb throws without it
 * (`packages/server/src/engine/worker/runner.ts:225`, `:229`). Here the module
 * is imported directly, which is the same set of functions with the seam taken
 * out — the seam exists to keep a host import out of a worker, and there is no
 * worker in a fixture generator.
 */
async function timeApi(): Promise<Record<string, unknown>> {
  const time = (await import("@centraid/core/time")) as Record<string, unknown>;
  return time;
}
