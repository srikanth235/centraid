import { describe, expect, it } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";

import { data, harness, note, state } from "./logic.test-fixtures.ts";
import type { Harness } from "./logic.test-fixtures.ts";
import { notebookCounts, rowsFor, tagCounts, unfiledCount } from "./logic.ts";
import { TRASH, notebookShelf } from "./shelves.ts";

describe("search never claims an empty result it did not verify", () => {
  it("waits out the burst, then asks the vault once", async () => {
    const clock = useFakeClock();
    const app = harness({ read: async () => ({ notes: [] }) });
    app.logic.runSearch("oa");
    app.logic.runSearch("oat");
    await clock.advance(150);
    expect(app.asked).toStrictEqual([
      { query: "search", input: { term: "oat" } },
    ]);
  });

  it("goes back to rest on an emptied box without asking anything", async () => {
    const clock = useFakeClock();
    const app = harness({ state: { search: "oat", searchStatus: "ready" } });
    app.logic.runSearch("   ");
    await clock.advance(150);
    expect(app.asked).toStrictEqual([]);
    expect(app.state.searchResults).toBeNull();
    expect(app.state.searchStatus).toBe("resting");
  });

  it("holds the matches and calls itself ready", async () => {
    const clock = useFakeClock();
    const hit = note({ note_id: "n1" });
    const app = harness({ read: async () => ({ notes: [hit] }) });
    app.logic.runSearch("oat");
    await clock.advance(150);
    expect(app.state.searchResults).toStrictEqual([hit]);
    expect(app.state.searchStatus).toBe("ready");
  });

  it("calls a DENIAL unreachable, never 'nothing matches'", async () => {
    const clock = useFakeClock();
    const app = harness({
      read: async () => ({ vaultDenied: { code: "VAULT_ACCESS" } }),
    });
    app.logic.runSearch("oat");
    await clock.advance(150);
    expect(app.state.searchResults).toBeNull();
    expect(app.state.searchStatus).toBe("unreachable");
  });

  it("calls a THROW unreachable too", async () => {
    const clock = useFakeClock();
    const app = harness({
      read: async () => {
        throw new Error("offline");
      },
    });
    app.logic.runSearch("oat");
    await clock.advance(150);
    expect(app.state.searchStatus).toBe("unreachable");
  });

  it("drops an answer to a query the member has already moved past", async () => {
    const clock = useFakeClock();
    const app: Harness = harness({
      read: async () => {
        app.state.searchSeq += 5;
        return { notes: [note({ note_id: "stale" })] };
      },
    });
    app.logic.runSearch("oat");
    await clock.advance(150);
    expect(app.state.searchResults).toBeNull();
  });

  it("clears the box and bumps the sequence so a live read cannot land", () => {
    const app = harness({
      state: { search: "oat", searchStatus: "ready", searchResults: [] },
    });
    app.logic.clearSearch();
    expect(app.state).toMatchObject({
      search: "",
      searchResults: null,
      searchStatus: "resting",
      searchSeq: 1,
    });
  });
});

describe("the [[ powerbox probe", () => {
  it("asks for link targets once the typing settles", async () => {
    const clock = useFakeClock();
    const targets = [
      { type: "task", id: "t1", title: "Oat milk", app: "tasks" },
    ];
    const app = harness({ read: async () => ({ targets }) });
    app.logic.probeTargets("  oat  ");
    await clock.advance(120);
    expect(app.asked).toStrictEqual([
      { query: "link-targets", input: { term: "oat" } },
    ]);
    expect(app.state.powerbox.targets).toStrictEqual(targets);
    expect(app.state.powerbox.term).toBe("oat");
  });

  it("empties the candidate list on an emptied term, without asking", async () => {
    const clock = useFakeClock();
    const app = harness({
      state: {
        powerbox: {
          open: true,
          term: "oat",
          targets: [{ type: "task", id: "t1", title: "x", app: "tasks" }],
          anchor: { exact: "", prefix: "", suffix: "", start: 0 },
        },
      },
    });
    app.logic.probeTargets("");
    await clock.advance(120);
    expect(app.asked).toStrictEqual([]);
    expect(app.state.powerbox.targets).toStrictEqual([]);
  });

  it("empties the candidate list rather than keeping stale ones when the read threw", async () => {
    const clock = useFakeClock();
    const app = harness({
      state: {
        powerbox: {
          open: true,
          term: "o",
          targets: [{ type: "task", id: "t1", title: "x", app: "tasks" }],
          anchor: { exact: "", prefix: "", suffix: "", start: 0 },
        },
      },
      read: async () => {
        throw new Error("offline");
      },
    });
    app.logic.probeTargets("oat");
    await clock.advance(120);
    expect(app.state.powerbox.targets).toStrictEqual([]);
  });
});

describe("the rows a route paints", () => {
  const rows = [
    note({
      note_id: "a",
      updated_at: "2026-08-01",
      notebook_ids: ["b1"],
      tags: [{ tag_id: "t1", concept_id: "c1", label: "recipes" }],
    }),
    note({ note_id: "b", updated_at: "2026-08-03", notebook_ids: [] }),
    note({
      note_id: "c",
      updated_at: "2026-08-02",
      pinned: 1,
      notebook_ids: ["b1", "b2"],
    }),
  ];
  const appData = data({ notes: rows, trash: [note({ note_id: "gone" })] });

  it("paints the trash on the trash shelf and nothing else", () => {
    expect(
      rowsFor(appData, state(), TRASH).map((r) => r.note_id)
    ).toStrictEqual(["gone"]);
  });

  it("sorts pinned first, then newest edited — and nothing else reorders it", () => {
    expect(rowsFor(appData, state(), null).map((r) => r.note_id)).toStrictEqual(
      ["c", "b", "a"]
    );
  });

  it("narrows to the open notebook", () => {
    const shown = rowsFor(appData, state(), notebookShelf("b2"));
    expect(shown.map((r) => r.note_id)).toStrictEqual(["c"]);
  });

  it("paints the ranked matches while a query is live", () => {
    const shown = rowsFor(
      appData,
      state({ search: "oat", searchResults: [rows[1]!] }),
      null
    );
    expect(shown.map((r) => r.note_id)).toStrictEqual(["b"]);
  });

  it("shows nothing rather than the library when a live query has no answer yet", () => {
    expect(
      rowsFor(appData, state({ search: "oat", searchResults: null }), null)
    ).toStrictEqual([]);
  });

  it("applies the This-notebook scope only where the member came from one", () => {
    const scoped = state({
      search: "oat",
      searchResults: rows,
      searchScope: "notebook",
      scopeNotebookId: "b2",
    });
    expect(rowsFor(appData, scoped, null).map((r) => r.note_id)).toStrictEqual([
      "c",
    ]);
    const unscoped = state({
      search: "oat",
      searchResults: rows,
      searchScope: "notebook",
      scopeNotebookId: null,
    });
    expect(rowsFor(appData, unscoped, null)).toHaveLength(3);
  });

  it("treats Unfiled as a filter over the library window", () => {
    expect(
      rowsFor(appData, state({ unfiledOnly: true }), null).map((r) => r.note_id)
    ).toStrictEqual(["b"]);
  });

  it("treats a tag as a lens, never as a place", () => {
    expect(
      rowsFor(appData, state({ conceptId: "c1" }), null).map((r) => r.note_id)
    ).toStrictEqual(["a"]);
  });

  it("counts the WINDOW, not the vault", () => {
    expect(
      [...notebookCounts(appData).entries()].toSorted(([a], [b]) =>
        a.localeCompare(b)
      )
    ).toStrictEqual([
      ["b1", 2],
      ["b2", 1],
    ]);
    expect(unfiledCount(appData)).toBe(1);
    expect([...tagCounts(appData).entries()]).toStrictEqual([["c1", 1]]);
  });
});
