// THE SCHEDULE LANE'S PARITY BUNDLE — the shape Agenda's and Tasks' fixtures
// share, and the canonicalisation that makes two runs agree byte for byte
// (#1020, wave 4 slot 4d, D-1020-D3-6).
//
// Split out of the two generators because they are one corpus seen twice: both
// apps read `schedule_task`, both read the `schedule` schema's own commands,
// and a second copy of the canonicaliser is a second place for `id-0007` to
// mean something else.
//
// WHY ROWS AND NOT A `vault.db.gz` (D-1020-D3-11) — unchanged from Tally's,
// Photos' and Docs' generators: `bootstrapVault` mints its ids as UUIDv7 off
// the clock, so a database file is not byte-reproducible; a compressed database
// is not reviewable; and Rust needs a schema to open anyway, which
// `contracts/schema/vault-ddl.sql` already is.
//
// WHY THE CORPUS IS SCRIPTED AND NOT THE DEMO SEED, unlike Docs'. Both seeds
// are HOST-LOCAL: `agenda/seed.js:38` builds every slot with
// `start.setHours(hour, minute, 0, 0)` and `tasks/seed.js:11` derives its days
// from `Date.now()`. A fixture whose bytes depend on the machine's zone is not
// a fixture, and pinning `TZ` around a Node process that has already cached it
// is not reliable. So the corpus here is a SCRIPT of the real typed commands
// at explicit instants, and the seeds' host-local dates are a finding in the
// lane's receipt rather than something this file works around silently.

/**
 * The instant the whole run is stamped at. Frozen, and in the far future for
 * the reason Tally's, Photos' and Docs' generators record: the vault has TWO
 * clocks, and a condition comparing `purge_at` against SQLite's own `now`
 * cannot be held still by a JS proxy, so a restore step cannot be fixtured at a
 * past epoch at all.
 *
 * It also does real work here: the task corpus anchors a repeating task in
 * 2026, so at this epoch the missed-period collapse is exercised **at its own
 * `MAX_MISSED` ceiling** rather than at two or three.
 */
export const PARITY_EPOCH = "2099-06-01T09:00:00.000Z";

/**
 * How far from [`PARITY_EPOCH`] an instant may sit and still count as the
 * FIXTURE's own time rather than the host's.
 *
 * **Much wider than Docs' 400 days, and it has to be**: this corpus carries
 * 2026 dates on purpose — the DST boundary the recurrence engine is judged on
 * is a real one — and a window that swallowed them would tokenise the very
 * instants the fixture exists to compare. So the host clock cannot be told
 * apart by DISTANCE here, and [`normaliseHostClock`] settles it at the source
 * instead: every `DEFAULT (strftime(…,'now'))` column is rewritten to a
 * deterministic instant before the handlers run. This window is what remains
 * as a backstop.
 */
export const FIXTURE_INSTANT_WINDOW_MS = 40_000 * 24 * 60 * 60 * 1000;

/**
 * REWRITE EVERY HOST-CLOCK COLUMN TO A DETERMINISTIC INSTANT.
 *
 * The vault has TWO clocks. `installFixtureClock` holds the JavaScript one, so
 * everything a command stamps with `ctx.now` is the fixture's; **SQLite's own
 * `DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))` is not**, and twelve
 * columns across this corpus' tables carry it — `core_vault.updated_at`,
 * `schedule_task.created_at`/`updated_at`, `schedule_event_ext`'s pair,
 * `schedule_attendee`'s pair, the concept plane's, `core_tag.updated_at` and
 * `schedule_calendar.created_at`.
 *
 * Docs' generator tokenises those to `(host-clock)` on distance from its
 * epoch. This corpus cannot: a 2026 host stamp and a 2026 DST occurrence are
 * the same distance from a 2099 epoch, and tokenising the second would delete
 * the fixture's whole point. So the values are settled here instead, **before
 * the handlers run**, so `rows.json` and `queries.json` describe one vault.
 *
 * The rewritten value is `PARITY_EPOCH` plus the row's physical ordinal in
 * seconds, per table. It is deterministic, it preserves the order the rows were
 * written in, and — because `tasks.board.open` sorts by `created_at` — it keeps
 * that window's order a fact about the data rather than about the machine.
 */
export function normaliseHostClock(
  vault: {
    prepare: (sql: string) => {
      all: (...args: unknown[]) => unknown[];
      run: (...args: unknown[]) => unknown;
    };
  },
  tables: readonly string[]
): number {
  const epoch = Date.parse(PARITY_EPOCH);
  // A stamp a COMMAND wrote sits on the fixture clock, within a few minutes of
  // the epoch; a stamp SQLite's own default wrote sits on the host's, decades
  // away. 400 days is the same window Docs' generator uses for the same
  // question, and it is comfortably inside the gap.
  const COMMAND_STAMP_MS = 400 * 24 * 60 * 60 * 1000;
  let rewritten = 0;
  for (const table of tables) {
    // ONLY the columns whose DEFAULT is `strftime(…,'now')`. A `due_at`, a
    // `dtstart` and a `purge_at` are DATA — the fixture carries 2026 dates on
    // purpose — and none of them has a default, so the discriminator is the
    // schema's own rather than a guess about the value.
    const columns = (
      vault.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
        dflt_value: string | null;
      }[]
    )
      .filter((column) => (column.dflt_value ?? "").includes("strftime"))
      .map((column) => column.name);
    if (columns.length === 0) continue;
    const ordinals = vault
      .prepare(
        `SELECT rowid AS rid, ${columns.join(", ")} FROM ${table} ORDER BY rowid`
      )
      .all() as Record<string, string | number | null>[];
    for (const [index, row] of ordinals.entries()) {
      for (const column of columns) {
        const value = row[column];
        if (typeof value !== "string") continue;
        const parsed = Date.parse(value);
        if (Number.isNaN(parsed)) continue;
        if (Math.abs(parsed - epoch) <= COMMAND_STAMP_MS) continue;
        vault
          .prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`)
          .run(
            new Date(epoch + index * 1000).toISOString(),
            row["rid"] as number
          );
        rewritten += 1;
      }
    }
  }
  return rewritten;
}

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
 * outputs.
 */
export interface CommandStep {
  command: string;
  input: Record<string, unknown>;
  output_keys: string[];
  status: string;
  /** The owner-facing sentence, on a step that is a refusal on purpose. */
  reason?: string;
}

export interface ScheduleParityBundle {
  rows: TableRows[];
  queries: QueryCase[];
  commands: CommandStep[];
}

/** The files each app's directory carries. */
export const SCHEDULE_PARITY_FILES = [
  "rows.json",
  "queries.json",
  "commands.json",
] as const;

export type ScheduleParityFile = (typeof SCHEDULE_PARITY_FILES)[number];

/**
 * Canonicalise the WHOLE bundle in one pass: every identifier to the order it
 * first appears, every host-clock instant to an ordered token.
 *
 * ONE PASS, NOT THREE. The files describe one vault: `rows.json` is the state
 * the cases in `queries.json` were read from. Canonicalised separately,
 * `id-0027` would name one thing in one file and another in the next, and the
 * Rust parity test — which builds its vault FROM the rows and then compares the
 * ported queries' answers to v0's, ids included — could not be written at all.
 *
 * THE HOST-CLOCK TOKEN IS PARENTHESISED, AND THAT IS LOAD-BEARING. `(` sorts
 * BELOW every digit under SQLite's BINARY collation, so a tokenised instant
 * still sorts where the real one did.
 */
export function canonicaliseBundle(
  bundle: ScheduleParityBundle
): ScheduleParityBundle {
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
  });
  const ids = new Map<string, string>();
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
  return JSON.parse(canonical) as ScheduleParityBundle;
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

/** The committed bytes, per file. */
export function payloadsFor(
  bundle: ScheduleParityBundle
): Record<ScheduleParityFile, string> {
  return {
    "rows.json": stableJson(bundle.rows),
    "queries.json": stableJson(bundle.queries),
    "commands.json": stableJson(bundle.commands),
  };
}

/**
 * `ctx.time`, exactly the set a seat hands a handler
 * (`packages/client/src/replica/inline-query-ctx-core.ts:223`-`:235`).
 *
 * Eight functions, and the occurrence-key adapter is three of them: a seat's
 * handlers read a stored exception through the same one adapter the gateway
 * worker's do, so the column is named in one place for both (#996 R21).
 */
export async function loadCtxTime(): Promise<Record<string, unknown>> {
  const base = "../../packages/core/src/time";
  const [recurrence, collapse, summary, occurrence] = await Promise.all([
    import(`${base}/recurrence.ts`),
    import(`${base}/recurrence-collapse.ts`),
    import(`${base}/recurrence-summary.ts`),
    import(`${base}/occurrence.ts`),
  ]);
  const time = {
    ...(recurrence as object),
    ...(collapse as object),
    ...(summary as object),
    ...(occurrence as object),
  } as Record<string, unknown>;
  for (const name of [
    "applyRecurrenceExceptions",
    "collapseMissedOccurrences",
    "describeRecurrence",
    "expandRecurrence",
    "occurrenceExceptionsOf",
    "overrideAt",
    "recurrenceExceptionsOf",
    "shiftTemporal",
  ]) {
    if (typeof time[name] !== "function") {
      throw new Error(`ctx.time is missing ${name}: the engine's shape moved`);
    }
  }
  return time;
}

/** Every row of every table, as data. */
export function tableRows(
  vault: {
    prepare: (sql: string) => {
      all: (...args: unknown[]) => unknown[];
    };
  },
  tables: readonly string[]
): TableRows[] {
  return tables.map((table) => {
    const columns = (
      vault.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
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
          // A BLOB reaches here as a Uint8Array. THE FIXTURE CARRIES NO BYTES.
          if (cell instanceof Uint8Array) return null;
          return (cell ?? null) as string | number | null;
        })
      ),
    };
  });
}
