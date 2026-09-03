import { describe, expect, it } from "vitest";

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
