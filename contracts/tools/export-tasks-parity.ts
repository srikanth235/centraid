// Export TASKS' parity fixtures from the v0 tree (#1020, wave 4 slot 4d,
// D-1020-D3-6).
//
// Same contract as Agenda's next door: a fresh v0 vault, the shared
// `schedule.*` script through the REAL typed commands, then both Tasks queries
// through the real handler path, and what came back is the fixture.
//
// WHAT IT WRITES, under `contracts/apps/tasks/`:
//
//   rows.json       every row of every table the two queries read, by table
//   queries.json    {query, input, output} for both, at fixed inputs
//   commands.json   the ordered `schedule.*` script, with `$from` references
//
// THE EVENT SCRIPT IS NOT RUN HERE. Tasks reads `schedule_task`,
// `schedule_project`, `schedule_section` and the `core.*` decoration planes and
// nothing else, so an event corpus would add rows no statement touches — and a
// fixture carrying rows no query reads is a fixture whose size says nothing
// about its coverage.
//
// THE BOARD'S DECLARED WINDOW IS COMPARED AT BOTH ENDS AND PAST BOTH. `board`
// has no module-level ceiling at all — the caller's `limit` is the whole bound
// (census §A7) — so the clamp IS the contract, and one under and one over are
// the cases a port that added a ceiling would answer differently.

import {
  canonicaliseBundle,
  normaliseHostClock,
  tableRows,
} from "./schedule-parity-bundle.js";
import type {
  QueryCase,
  ScheduleParityBundle,
} from "./schedule-parity-bundle.js";
import { openCorpus, runTaskScript } from "./schedule-parity-corpus.js";

export {
  PARITY_EPOCH,
  SCHEDULE_PARITY_FILES as TASKS_PARITY_FILES,
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
export const TASKS_PARITY_DIR = "contracts/apps/tasks";

/**
 * The tables the two Tasks queries read.
 *
 * Derived from the STATEMENTS, not from the manifest's `vault.scopes`.
 */
export const TASKS_PARITY_TABLES = [
  "core_vault",
  "core_party",
  "core_concept_scheme",
  "core_concept",
  "core_tag",
  "core_attachment",
  "core_content_item",
  "core_content_representation",
  "core_link",
  "core_link_anchor",
  "schedule_project",
  "schedule_section",
  "schedule_task",
] as const;

/** Both handlers, by the name their file carries. */
async function loadHandlers(): Promise<
  Record<string, (args: unknown) => Promise<unknown>>
> {
  const NAMES = ["board", "search"] as const;
  const modules = await Promise.all(
    NAMES.map(
      (name) =>
        import(`../../packages/blueprints/apps/tasks/queries/${name}.ts`)
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
export async function buildTasksParity(): Promise<ScheduleParityBundle> {
  const corpus = await openCorpus();
  try {
    runTaskScript(corpus);

    // THE HOST CLOCK IS SETTLED BEFORE THE HANDLERS RUN, so `rows.json` and
    // `queries.json` describe one vault (see `normaliseHostClock`).
    const rewritten = normaliseHostClock(corpus.db.vault, TASKS_PARITY_TABLES);
    if (rewritten === 0) {
      throw new Error(
        "no host-clock column was rewritten: the DEFAULT (strftime(…,'now')) columns moved"
      );
    }

    const handlers = await loadHandlers();
    const cases: QueryCase[] = [];
    const run = async (query: string, input: Record<string, unknown>) => {
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

    // THE DECLARED FLOOR AND CEILING, plus one under and one over — which is
    // the clamp, and not an error.
    await run("board", {});
    await run("board", { limit: 20 });
    await run("board", { limit: 500 });
    await run("board", { limit: 1 });
    await run("board", { limit: 9000 });
    // A window of exactly two, so `truncated` is the page's own cursor on a
    // set that is longer than it.
    await run("board", { limit: 20 });

    await run("search", { term: "cabin" });
    await run("search", { term: "tahoe" });
    await run("search", { term: "plants" });
    await run("search", { term: "zzzz" });
    await run("search", { term: "" });

    const rows = tableRows(corpus.db.vault, TASKS_PARITY_TABLES);
    return canonicaliseBundle({
      rows,
      queries: cases,
      commands: corpus.commands,
    });
  } finally {
    corpus.close();
  }
}
