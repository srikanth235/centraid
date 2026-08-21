import { describe, expect, it } from "vitest";

// Agenda's search read (#839 W2-1) — split out of `logic.test.ts`, which holds
// the write side; the seat both drive is `logic.test-fixtures.ts`.
//
// SEARCH ASKS THE VAULT, never the loaded window, and it is the second place
// this app paints before the vault has spoken. So the cases below are driven on
// the fake clock (coalescing is the whole point of the debounce, and a suite
// that awaited the read directly would prove nothing about the delay) and each
// pins what the pane holds when the answer never comes, comes late, or comes
// for a term the member has already typed past. A THROW IS NOT AN EMPTY RESULT
// SET: "nothing matches" is a claim about the vault, and the app may only make
// it when the vault said so.
import { useFakeClock } from "@centraid/test-kit/fake-clock";

import type { Harness } from "./logic.test-fixtures.ts";
import { event, harness } from "./logic.test-fixtures.ts";

describe("search asks the vault, never the loaded window", () => {
  it("coalesces the typing into one read", async () => {
    const clock = useFakeClock();
    const app = harness({ read: async () => ({ events: [] }) });
    app.logic.applySearchInput("den");
    app.logic.applySearchInput("dentist");
    await clock.advance(200);
    expect(app.asked).toStrictEqual([
      { query: "search", input: { term: "dentist" } },
    ]);
  });

  it("keeps the member's own text, spaces and all", async () => {
    const clock = useFakeClock();
    const app = harness({ read: async () => ({ events: [] }) });
    app.logic.applySearchInput("  dentist ");
    await clock.advance(200);
    expect(app.state.search).toBe("  dentist ");
    expect(app.state.searchResults).toStrictEqual([]);
  });

  it("drops back to no search on a box holding only spaces", async () => {
    const clock = useFakeClock();
    const app = harness({
      state: { searchResults: [event({ event_id: "e1" })] },
    });
    app.logic.applySearchInput("   ");
    await clock.advance(200);
    expect(app.asked).toStrictEqual([]);
    expect(app.state.searchResults).toBeNull();
  });

  it("holds the matches the vault found", async () => {
    const clock = useFakeClock();
    const hit = event({ event_id: "e1" });
    const app = harness({ read: async () => ({ events: [hit] }) });
    app.logic.applySearchInput("dentist");
    await clock.advance(200);
    expect(app.state.searchResults).toStrictEqual([hit]);
  });

  it("reads a missing events key as an empty match set", async () => {
    const clock = useFakeClock();
    const app = harness({ read: async () => ({}) });
    app.logic.applySearchInput("dentist");
    await clock.advance(200);
    expect(app.state.searchResults).toStrictEqual([]);
  });

  it("says UNKNOWN — not 'nothing matches' — when the index was out of reach", async () => {
    const clock = useFakeClock();
    const app = harness({
      read: async () => {
        throw new Error("offline");
      },
    });
    app.logic.applySearchInput("dentist");
    await clock.advance(200);
    expect(app.state.searchResults).toBeNull();
  });

  it("drops an answer the member has already typed past", async () => {
    const clock = useFakeClock();
    const app: Harness = harness({
      read: async () => {
        // A second keystroke lands while this read is in flight.
        app.logic.clearSearch();
        return { events: [event({ event_id: "stale" })] };
      },
    });
    app.logic.applySearchInput("dentist");
    await clock.advance(200);
    expect(app.state.searchResults).toBeNull();
  });

  it("clears the box and bars a live read from landing", async () => {
    const clock = useFakeClock();
    const app = harness({
      state: { search: "dentist", searchResults: [event({ event_id: "e1" })] },
    });
    app.logic.clearSearch();
    expect(app.state.search).toBe("");
    expect(app.state.searchResults).toBeNull();
    await clock.advance(200);
    expect(app.asked).toStrictEqual([]);
  });
});
