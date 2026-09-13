// Export AGENDA's parity fixtures from the v0 tree (#1020, wave 4 slot 4d,
// D-1020-D3-6).
//
// WHY GENERATED AND NOT TYPED. v0 is the executable specification. A parity
// fixture typed by hand is a fixture that says what its author believed the
// handlers do; this one says what they do. So the generator founds a fresh v0
// vault, runs the shared `schedule.*` script through the REAL typed commands,
// then invokes all four Agenda queries through the real handler path — the same
// statement-as-data through the same paged door, with the same `ctx.time` a
// seat hands a handler — and writes what came back.
//
// WHAT IT WRITES, under `contracts/apps/agenda/`:
//
//   rows.json       every row of every table the four queries read, by table
//   queries.json    {query, input, output} for all four, at fixed inputs
//   commands.json   the ordered `schedule.*` script, with `$from` references
//
// THE CORPUS CARRIES THE MARCH 2026 DST BOUNDARY ON PURPOSE. A daily 09:00
// New York series expands across the spring transition, so the fixture
// contains an occurrence whose instant moves by an hour while its wall clock
// does not — which is the whole of `docs/cron-timezone.md`'s policy, and the
// one thing a recurrence port cannot fake.

import {
  PARITY_EPOCH,
  canonicaliseBundle,
  normaliseHostClock,
  tableRows,
} from "./schedule-parity-bundle.js";
import type {
  QueryCase,
  ScheduleParityBundle,
} from "./schedule-parity-bundle.js";
import { openCorpus } from "./schedule-parity-corpus.js";
import { runEventScript, runTaskScript } from "./schedule-parity-script.js";

export {
  PARITY_EPOCH,
  SCHEDULE_PARITY_FILES as AGENDA_PARITY_FILES,
  payloadsFor,
  stableJson,
} from "./schedule-parity-bundle.js";
export type {
  CommandStep,
  QueryCase,
  ScheduleParityBundle,
  TableRows,
} from "./schedule-parity-bundle.js";

/** Where the bundle is written, relative to the repository root. */
export const AGENDA_PARITY_DIR = "contracts/apps/agenda";

/**
 * The tables the four Agenda queries read.
 *
 * Derived from the STATEMENTS, not from the manifest's `vault.scopes`: the
 * manifest declares reach and the statements are what ran. `schedule_task`,
 * `schedule_project` and `schedule_section` are here because the calendar
 * grid's due-work shelf reads them (`day-context.ts:158`).
 */
export const AGENDA_PARITY_TABLES = [
  "core_vault",
  "core_party",
  "core_concept_scheme",
  "core_concept",
  "core_tag",
  "core_event",
  "core_attachment",
  "core_content_item",
  "core_content_representation",
  "schedule_calendar",
  "schedule_event_ext",
  "schedule_attendee",
  "schedule_recurrence_exception",
  "schedule_project",
  "schedule_section",
  "schedule_task",
] as const;

/** The four handlers, by the name their file carries. */
async function loadHandlers(): Promise<
  Record<string, (args: unknown) => Promise<unknown>>
> {
  const NAMES = ["upcoming", "search", "day-context", "parties"] as const;
  // THE SPECIFIERS ARE COMPUTED, NOT LITERAL: a literal import pulls the whole
  // blueprint handler graph into whatever TypeScript program type-checks this
  // file, and no program that can also see `packages/vault/src` has both
  // tsconfigs.
  const modules = await Promise.all(
    NAMES.map(
      (name) =>
        import(`../../packages/blueprints/apps/agenda/queries/${name}.ts`)
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

/** Build the whole bundle. Opens and closes its own vault. */
export async function buildAgendaParity(): Promise<ScheduleParityBundle> {
  const corpus = await openCorpus();
  try {
    // The task script FIRST, because its `$from` references are absolute step
    // indices from zero; the event script then starts where it left off.
    runTaskScript(corpus);
    runEventScript(corpus, corpus.commands.length);

    // THE HOST CLOCK IS SETTLED BEFORE THE HANDLERS RUN, so `rows.json` and
    // `queries.json` describe one vault (see `normaliseHostClock`).
    const rewritten = normaliseHostClock(corpus.db.vault, AGENDA_PARITY_TABLES);
    if (rewritten === 0) {
      throw new Error(
        "no host-clock column was rewritten: the DEFAULT (strftime(…,'now')) columns moved"
      );
    }

    const handlers = await loadHandlers();
    const cases: QueryCase[] = [];
    const run = async (query: string, input: Record<string, unknown>) => {
      // Sequential on purpose: the statements a handler makes are recorded in
      // order, and two handlers in flight would interleave them.
      cases.push({
        query,
        input,
        output: await handlers[query]!({
          ctx: corpus.ctx,
          input,
          query: input,
        }),
      });
    };

    // THE DEFAULT RANGE, then the two ranges that matter: the corpus' own week
    // and the DST window the recurrence engine is judged on.
    await run("upcoming", {});
    await run("upcoming", {
      from: "2099-06-01T00:00:00.000Z",
      to: "2099-06-12T00:00:00.000Z",
    });
    await run("upcoming", {
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-03-20T00:00:00.000Z",
    });
    // An open-ended range: the expansion's own ceiling, not the caller's.
    await run("upcoming", { from: "2026-03-01T00:00:00.000Z" });
    // A range the corpus has nothing in.
    await run("upcoming", {
      from: "2100-01-01T00:00:00.000Z",
      to: "2100-02-01T00:00:00.000Z",
    });

    await run("search", { term: "standup" });
    await run("search", { term: "maya" });
    await run("search", { term: "dentist" });
    await run("search", { term: "zzzz" });
    await run("search", { term: "" });

    await run("day-context", {});
    await run("day-context", { from: "2099-06-01", to: "2099-06-12" });
    // An inverted range: the default window stands rather than an error.
    await run("day-context", { from: "2099-06-10", to: "2099-06-01" });
    // Past the declared ceiling: clamped to 400 days, not refused.
    await run("day-context", { from: "2099-06-01", to: "2103-06-01" });
    // A malformed bound: not a floor, and not a refusal.
    await run("day-context", { from: "banana" });

    await run("parties", {});

    const rows = tableRows(corpus.db.vault, AGENDA_PARITY_TABLES);
    return canonicaliseBundle({
      rows,
      queries: cases,
      commands: corpus.commands,
    });
  } finally {
    corpus.close();
  }
}

void PARITY_EPOCH;
