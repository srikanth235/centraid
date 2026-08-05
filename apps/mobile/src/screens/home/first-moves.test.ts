/**
 * What Home offers for the apps that have not earned the grid.
 *
 * The module under test is pure, so these are list assertions — but the list is
 * the product decision: which invitations a member sees, in what order, and
 * whether any of them can appear for an app that already has content.
 */
import { describe, expect, it } from "vitest";

import { FIRST_MOVE_LIMIT, firstMoves } from "./first-moves";

describe(firstMoves, () => {
  it("leads with connecting an account, whose result is bigger than the act", () => {
    expect(firstMoves(["photos", "docs"])[0]?.id).toBe("connectors");
  });

  it("offers nothing at all once every app has earned the grid", () => {
    expect(firstMoves([])).toStrictEqual([]);
  });

  it("never offers a move for an app that is not idle", () => {
    const ids = firstMoves(["tally"]).map((move) => move.id);
    expect(ids).toContain("tally");
    expect(ids).not.toContain("photos");
    expect(ids).not.toContain("notes");
  });

  it("stays at three, so a nudge never grows as tall as the grid", () => {
    const all = ["photos", "docs", "notes", "agenda", "tasks", "people"];
    expect(firstMoves(all)).toHaveLength(FIRST_MOVE_LIMIT);
  });

  it("follows leverage order, which is not springboard order", () => {
    expect(
      firstMoves(["tasks", "photos", "notes"]).map((m) => m.id)
    ).toStrictEqual(["connectors", "photos", "notes"]);
  });

  it("gives every app move its identity hue and leaves the non-app move without one", () => {
    const moves = firstMoves(["photos"]);
    expect(
      moves.find((move) => move.id === "connectors")?.color
    ).toBeUndefined();
    expect(moves.find((move) => move.id === "photos")?.color).toBeTruthy();
  });

  it("carries a label and a hint on every move — an invitation with no reason is a dead end", () => {
    for (const move of firstMoves(["photos", "docs", "notes"])) {
      expect(move.label.length).toBeGreaterThan(0);
      expect(move.hint.length).toBeGreaterThan(0);
    }
  });

  it("ignores an id that is not an app and has no copy", () => {
    expect(firstMoves(["not-an-app"]).map((move) => move.id)).toStrictEqual([
      "connectors",
    ]);
  });
});
