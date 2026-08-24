/*! Browser-JS fixtures intentionally lack TypeScript declarations. (#408) */
// oxlint-disable-next-line typescript/ban-ts-comment -- (#408) these browser-JS fixture imports have no TypeScript declarations
// @ts-nocheck -- the imported browser fixtures intentionally lack declarations
// Stage-0 handler coverage for issue #834: Agenda's new read-only
// `day-context` projection (R-daycontext / R-shelf-scope) and the
// People-journal exclusion the three Notes list queries now apply
// (R-journal). Same shape as query-handlers.test.ts — a mocked `ctx.vault`
// keyed by entity, the handler invoked the way the dispatcher invokes it.
import { describe, expect, it } from "vitest";

interface ReadCall {
  entity: string;
  where?: Array<{ column: string; op: string; value?: unknown }>;
  limit?: number;
}

/**
 * A mock ctx.vault returning fixture rows keyed by entity, recording every
 * read so the boundedness contract can be asserted rather than assumed. The
 * fixtures deliberately do NOT apply `where` — each handler re-narrows in
 * memory, which is what keeps it correct against a mock and a real vault
 * alike.
 */
function ctxOf(
  rowsByEntity: Record<string, unknown[]>,
  calls: ReadCall[] = []
) {
  return {
    calls,
    vault: {
      read: async (request: ReadCall) => {
        calls.push(request);
        return { rows: rowsByEntity[request.entity] ?? [] };
      },
      search: async ({ entity }: { entity: string }) => ({
        rows: rowsByEntity[`search:${entity}`] ?? [],
      }),
      resolve: async () => ({ cards: [] }),
      invoke: async () => ({ status: "executed", output: {} }),
    },
  };
}

const importQuery = (relativePath: string) => import(relativePath);

const FLAGS_SCHEME = "https://centraid.dev/schemes/flags";
const JOURNAL_SCHEME = "https://centraid.dev/schemes/people-journal";

// ── Agenda: day-context ────────────────────────────────────────────────────

/** A vault holding two people, one starred, and four tasks. */
function dayContextRows() {
  return {
    "core.party": [
      {
        party_id: "party-priya",
        kind: "person",
        display_name: "Priya",
        birth_date: "--03-14",
      },
      {
        party_id: "party-dana",
        kind: "person",
        display_name: "Dana",
        birth_date: "1988-03-20",
      },
      // Outside the window entirely.
      {
        party_id: "party-sam",
        kind: "person",
        display_name: "Sam",
        birth_date: "--11-02",
      },
    ],
    "core.concept_scheme": [{ scheme_id: "scheme-flags", uri: FLAGS_SCHEME }],
    "core.concept": [
      {
        concept_id: "concept-starred",
        scheme_id: "scheme-flags",
        notation: "starred",
      },
    ],
    "core.tag": [
      {
        target_id: "party-priya",
        target_type: "core.party",
        concept_id: "concept-starred",
      },
    ],
    "schedule.task": [
      // Date-only due.
      {
        task_id: "t1",
        status: "needs-action",
        title: "File the return",
        due_at: "2026-03-14",
      },
      // Timed due, same day.
      {
        task_id: "t2",
        status: "in-process",
        title: "Call the plumber",
        due_at: "2026-03-14T09:30:00Z",
      },
      {
        task_id: "t3",
        status: "needs-action",
        title: "Renew the passport",
        due_at: "2026-03-20",
      },
      // Closed tasks never count.
      { task_id: "t4", status: "completed", due_at: "2026-03-14" },
      // Outside the window.
      { task_id: "t5", status: "needs-action", due_at: "2026-05-01" },
    ],
  };
}

describe("Agenda day-context (#834 R-daycontext)", () => {
  it("projects birthdays in the window with their relationship tier", async () => {
    const { default: dayContext } = await importQuery(
      "../apps/agenda/queries/day-context.ts"
    );
    const ctx = ctxOf(dayContextRows());
    const result = await dayContext({
      input: { from: "2026-03-01", to: "2026-03-31" },
      ctx,
    });
    expect(result.birthdays).toStrictEqual([
      {
        party_id: "party-priya",
        name: "Priya",
        month: 3,
        day: 14,
        tier: "inner",
      },
      {
        party_id: "party-dana",
        name: "Dana",
        month: 3,
        day: 20,
        tier: "outer",
      },
    ]);
    // A birthday outside the asked window is absent, not tiered-and-dropped.
    expect(JSON.stringify(result.birthdays)).not.toContain("Sam");
  });

  it("buckets open due tasks by day, date-only and timed alike", async () => {
    const { default: dayContext } = await importQuery(
      "../apps/agenda/queries/day-context.ts"
    );
    const ctx = ctxOf(dayContextRows());
    const result = await dayContext({
      input: { from: "2026-03-01", to: "2026-03-31" },
      ctx,
    });
    // A day carries its COUNT and the first few rows behind it: the shelf
    // lists what is due without becoming a second task board, so identity and
    // title are all a row projects and the tap-through belongs to Tasks.
    expect(result.due).toStrictEqual([
      {
        day: "2026-03-14",
        count: 2,
        tasks: [
          { task_id: "t1", title: "File the return" },
          { task_id: "t2", title: "Call the plumber" },
        ],
      },
      {
        day: "2026-03-20",
        count: 1,
        tasks: [{ task_id: "t3", title: "Renew the passport" }],
      },
    ]);
    // No holiday source exists in the vault, so the field is honestly empty.
    expect(result.holidays).toStrictEqual([]);
  });

  it("keeps every growth-entity read bounded", async () => {
    const { default: dayContext } = await importQuery(
      "../apps/agenda/queries/day-context.ts"
    );
    const calls: ReadCall[] = [];
    const ctx = ctxOf(dayContextRows(), calls);
    await dayContext({ input: { from: "2026-03-01", to: "2026-03-31" }, ctx });
    const bounded = (call: ReadCall) =>
      typeof call.limit === "number" ||
      (call.where ?? []).some((clause) => ["eq", "in"].includes(clause.op));
    expect(calls.map((call) => call.entity)).toContain("schedule.task");
    expect(calls.filter((call) => !bounded(call))).toStrictEqual([]);
    const tasks = calls.find((call) => call.entity === "schedule.task");
    expect(tasks?.limit).toBeGreaterThan(0);
  });

  it("caps an over-long range instead of reading it", async () => {
    const { default: dayContext } = await importQuery(
      "../apps/agenda/queries/day-context.ts"
    );
    const calls: ReadCall[] = [];
    const ctx = ctxOf(dayContextRows(), calls);
    await dayContext({ input: { from: "2026-01-01", to: "2099-01-01" }, ctx });
    const upper = calls
      .find((call) => call.entity === "schedule.task")
      ?.where?.find(
        (clause) => clause.column === "due_at" && clause.op === "lt"
      )?.value;
    // 400 days past 2026-01-01, plus the exclusive day after it.
    expect(upper).toBe("2027-02-06");
  });

  it("answers the same shape empty with vaultDenied on a denial", async () => {
    const { default: dayContext } = await importQuery(
      "../apps/agenda/queries/day-context.ts"
    );
    const ctx = ctxOf({});
    ctx.vault.read = async () => {
      throw Object.assign(new Error("no grant"), { code: "VAULT_CONSENT" });
    };
    const result = await dayContext({
      input: { from: "2026-03-01", to: "2026-03-31" },
      ctx,
    });
    expect(result).toStrictEqual({
      birthdays: [],
      due: [],
      holidays: [],
      vaultDenied: { code: "VAULT_CONSENT", message: "no grant" },
    });
  });
});

// ── Notes: journal exclusion ───────────────────────────────────────────────

const dataUri = (text: string) =>
  `data:text/markdown,${encodeURIComponent(text)}`;

/**
 * One journal note and one ordinary note, each tagged with its own concept,
 * so an exclusion that leaked would be visible twice over: as a row, and as
 * the filter chip its concept becomes.
 */
function notesRows() {
  return {
    "knowledge.note": [
      {
        note_id: "note-plain",
        title: "Groceries",
        updated_at: "2026-08-20T10:00:00Z",
        body_content_id: "content-plain",
        deleted_at: null,
      },
      {
        note_id: "note-journal",
        title: "Coffee with Priya",
        updated_at: "2026-08-21T10:00:00Z",
        body_content_id: "content-journal",
        deleted_at: null,
      },
    ],
    "core.concept_scheme": [
      { scheme_id: "scheme-journal", uri: JOURNAL_SCHEME },
      { scheme_id: "scheme-topics", uri: "https://centraid.dev/schemes/tags" },
    ],
    "core.concept": [
      {
        concept_id: "concept-entry",
        scheme_id: "scheme-journal",
        notation: "entry",
        pref_label: "Journal entry",
      },
      {
        concept_id: "concept-errands",
        scheme_id: "scheme-topics",
        pref_label: "Errands",
      },
    ],
    "core.tag": [
      {
        tag_id: "tag-1",
        target_type: "knowledge.note",
        target_id: "note-journal",
        concept_id: "concept-entry",
      },
      {
        tag_id: "tag-2",
        target_type: "knowledge.note",
        target_id: "note-plain",
        concept_id: "concept-errands",
      },
    ],
    "core.content_item": [
      { content_id: "content-plain", content_uri: dataUri("milk") },
      { content_id: "content-journal", content_uri: dataUri("she is well") },
    ],
    "core.collection": [],
    "core.collection_entry": [],
    "core.attachment": [],
    "core.link": [],
    "core.link_anchor": [],
  };
}

describe("Notes journal exclusion (#834 R-journal)", () => {
  it("keeps journal notes and their concepts out of the library", async () => {
    const { default: library } = await importQuery(
      "../apps/notes/queries/library.ts"
    );
    const result = await library({ input: {}, ctx: ctxOf(notesRows()) });
    expect(
      result.notes.map((note: { note_id: string }) => note.note_id)
    ).toStrictEqual(["note-plain"]);
    expect(result.trash).toStrictEqual([]);
    // The journal-only concept must not survive as a filter chip.
    expect(
      result.tags.map((tag: { concept_id: string }) => tag.concept_id)
    ).toStrictEqual(["concept-errands"]);
    expect(JSON.stringify(result)).not.toContain("she is well");
  });

  it("drops journal notes from search hits", async () => {
    const { default: search } = await importQuery(
      "../apps/notes/queries/search.ts"
    );
    const rows = notesRows();
    const ctx = ctxOf({
      ...rows,
      "search:knowledge.note": rows["knowledge.note"],
    });
    const result = await search({ input: { term: "coffee" }, ctx });
    expect(
      result.notes.map((note: { note_id: string }) => note.note_id)
    ).toStrictEqual(["note-plain"]);
  });

  it("drops journal notes from the link-target powerbox", async () => {
    const { default: linkTargets } = await importQuery(
      "../apps/notes/queries/link-targets.ts"
    );
    const rows = notesRows();
    const ctx = ctxOf({
      ...rows,
      "search:knowledge.note": rows["knowledge.note"],
    });
    const result = await linkTargets({ input: { term: "coffee" }, ctx });
    const noteTargets = result.targets.filter(
      (target: { type: string }) => target.type === "knowledge.note"
    );
    expect(
      noteTargets.map((target: { id: string }) => target.id)
    ).toStrictEqual(["note-plain"]);
  });

  it("makes the Notes column absent when the marker read is denied", async () => {
    const { default: linkTargets } = await importQuery(
      "../apps/notes/queries/link-targets.ts"
    );
    const rows = notesRows();
    const ctx = ctxOf({
      ...rows,
      "search:knowledge.note": rows["knowledge.note"],
    });
    ctx.vault.read = async () => {
      throw Object.assign(new Error("no grant"), { code: "VAULT_CONSENT" });
    };
    const result = await linkTargets({ input: { term: "coffee" }, ctx });
    expect(
      result.targets.filter(
        (target: { type: string }) => target.type === "knowledge.note"
      )
    ).toStrictEqual([]);
  });
});
