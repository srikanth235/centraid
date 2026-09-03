import { describe, expect, it } from "vitest";

import {
  buildHomeTiles,
  HOME_TILE_ORDER,
  homeFirstMoves,
  partitionHomeTiles,
  taskRows,
} from "./homeTiles.js";
import type { HomeTileContent } from "./homeTiles.js";

const ALL: readonly string[] = [...HOME_TILE_ORDER];
const NOW = Date.parse("2026-08-03T12:00:00Z");

function tilesOf(
  content: HomeTileContent,
  installedIds: readonly string[] = ALL
) {
  return buildHomeTiles({ content, installedIds, now: NOW });
}

function bodyOf(content: HomeTileContent, id: string) {
  return tilesOf(content).find((tile) => tile.id === id)?.body;
}

describe("shell/routes/homeTiles", () => {
  describe(buildHomeTiles, () => {
    it("shows one tile per installed first-party app, in springboard order", () => {
      const tiles = tilesOf({}, ["locker", "agenda", "photos"]);
      expect(tiles.map((tile) => tile.id)).toStrictEqual([
        "photos",
        "agenda",
        "locker",
      ]);
    });

    it("leads with the imagery and prose bodies, not the chips", () => {
      expect([...HOME_TILE_ORDER].slice(0, 3)).toStrictEqual([
        "photos",
        "docs",
        "notes",
      ]);
    });

    it("does not tile an app the vault has not installed", () => {
      expect(tilesOf({}, ["agenda"]).map((tile) => tile.id)).toStrictEqual([
        "agenda",
      ]);
    });

    it("ignores ids that are not first-party apps", () => {
      expect(tilesOf({}, ["some-user-app"])).toStrictEqual([]);
    });

    it("carries the invariant header: name, identity keys, and a count", () => {
      const tile = tilesOf({ notes: { total: 1_204, line: "Hi" } }).find(
        (candidate) => candidate.id === "notes"
      );
      expect(tile).toMatchObject({
        colorKey: "slate",
        count: 1_204,
        countLabel: "notes",
        iconKey: "Book",
        name: "Notes",
      });
    });

    it("has no count for tally — the figure IS the number", () => {
      const tile = tilesOf({
        tally: { balanceMinor: 500, currency: "USD" },
      }).find((candidate) => candidate.id === "tally");
      expect(tile?.count).toBeNull();
    });

    it("marks an app with no read result empty, and carries no copy for it", () => {
      expect(bodyOf({}, "docs")).toStrictEqual({ kind: "empty" });
    });
  });

  describe("bodies are structurally distinct per app", () => {
    it("photos is a bounded mosaic with the remainder as +N", () => {
      const thumbs = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
      expect(bodyOf({ photos: { thumbs, total: 30 } }, "photos")).toStrictEqual(
        {
          kind: "photos",
          more: 22,
          thumbs: ["a", "b", "c", "d", "e", "f", "g", "h"],
        }
      );
    });

    it("counts the remainder off what it SHOWS when there are fewer than eight", () => {
      expect(
        bodyOf({ photos: { thumbs: ["a", "b", "c"], total: 30 } }, "photos")
      ).toStrictEqual({
        kind: "photos",
        more: 27,
        thumbs: ["a", "b", "c"],
      });
    });

    it("agenda pins the event AFTER the next one to the tile bottom", () => {
      const body = bodyOf(
        {
          agenda: {
            events: [
              { at: "2026-08-03T14:00:00Z", title: "Dentist" },
              { at: "2026-08-03T16:30:00Z", title: "Standup" },
            ],
            total: 2,
          },
        },
        "agenda"
      );
      expect(body).toMatchObject({ kind: "agenda", title: "Dentist" });
      expect(body).toHaveProperty("after", expect.stringContaining("Standup"));
    });

    it("agenda leaves the after-line empty when nothing follows", () => {
      const body = bodyOf(
        {
          agenda: {
            events: [{ at: "2026-08-03T14:00:00Z", title: "Only one" }],
            total: 1,
          },
        },
        "agenda"
      );
      expect(body).toHaveProperty("after", "");
    });

    it("people becomes initialled face circles plus a remainder", () => {
      expect(
        bodyOf(
          {
            people: {
              directory: [
                { id: "party-ada", name: "Ada Lovelace" },
                { id: "party-grace", name: "Grace Hopper" },
                { id: "party-alan", name: "Alan Turing" },
                { id: "party-ken", name: "Ken" },
                { id: "party-x", name: "X" },
              ],
              total: 12,
            },
          },
          "people"
        )
      ).toStrictEqual({
        faces: [
          { id: "party-ada", initials: "AL", name: "Ada Lovelace" },
          { id: "party-grace", initials: "GH", name: "Grace Hopper" },
          { id: "party-alan", initials: "AT", name: "Alan Turing" },
          { id: "party-ken", initials: "K", name: "Ken" },
        ],
        kind: "people",
        more: 8,
      });
    });

    it("tally is one figure in the reader's currency", () => {
      expect(
        bodyOf({ tally: { balanceMinor: 0, currency: "EUR" } }, "tally")
      ).toMatchObject({ caption: "All settled", kind: "tally" });
    });

    it("locker is a state chip that warns only when something is compromised", () => {
      expect(
        bodyOf({ locker: { compromised: 0, total: 9 } }, "locker")
      ).toStrictEqual({ chip: "All secure", kind: "locker", tone: "ok" });
      expect(
        bodyOf({ locker: { compromised: 2, total: 9 } }, "locker")
      ).toStrictEqual({
        chip: "2 need attention",
        kind: "locker",
        tone: "warn",
      });
    });

    it("notes carries a relative stamp beside its first line", () => {
      expect(
        bodyOf(
          {
            notes: {
              at: new Date(NOW - 3 * 3_600_000).toISOString(),
              line: "Reading list",
              total: 4,
            },
          },
          "notes"
        )
      ).toStrictEqual({ at: "3h ago", kind: "notes", line: "Reading list" });
    });

    it("docs falls back to the empty body when the newest row has no title", () => {
      expect(bodyOf({ docs: { total: 3 } }, "docs")).toStrictEqual({
        kind: "empty",
      });
    });
  });

  describe(taskRows, () => {
    it("shows open work first with at most ONE struck-through row", () => {
      expect(
        taskRows([
          { done: false, title: "a" },
          { done: true, title: "x" },
          { done: false, title: "b" },
          { done: false, title: "c" },
          { done: true, title: "y" },
        ])
      ).toStrictEqual([
        { done: false, title: "a" },
        { done: false, title: "b" },
        { done: true, title: "x" },
      ]);
    });

    it("fills the whole window with open work when nothing is done", () => {
      expect(
        taskRows([
          { done: false, title: "a" },
          { done: false, title: "b" },
          { done: false, title: "c" },
          { done: false, title: "d" },
        ])
      ).toHaveLength(3);
    });

    it("is empty for an empty board", () => {
      expect(taskRows([])).toStrictEqual([]);
    });
  });

  describe(partitionHomeTiles, () => {
    it("keeps only the tiles that have something to show in the grid", () => {
      const { live, idle } = partitionHomeTiles(
        tilesOf({ locker: { compromised: 0, total: 1 } })
      );
      expect(live.map((t) => t.id)).toStrictEqual(["locker"]);
      expect(idle.map((t) => t.id)).not.toContain("locker");
      expect(idle.length).toBeGreaterThan(0);
    });

    it("puts everything on the idle side when the vault is empty", () => {
      const { live, idle } = partitionHomeTiles(tilesOf({}));
      expect(live).toStrictEqual([]);
      expect(idle).toHaveLength(HOME_TILE_ORDER.length);
    });

    it("survives an empty tile list — a vault mid-mount has neither side", () => {
      expect(partitionHomeTiles([])).toStrictEqual({ idle: [], live: [] });
    });
  });

  describe(homeFirstMoves, () => {
    it("leads with connecting an account — one act that fills three tiles", () => {
      const moves = homeFirstMoves(tilesOf({}));
      expect(moves[0]?.id).toBe("connectors");
      expect(moves[0]?.kind).toBe("connectors");
      expect(moves.map((m) => m.id)).toStrictEqual([
        "connectors",
        "photos",
        "docs",
        "notes",
      ]);
    });

    it("never offers a move for an app that already has content", () => {
      const { idle } = partitionHomeTiles(
        tilesOf({ photos: { thumbs: ["a"], total: 1 } })
      );
      expect(homeFirstMoves(idle).map((m) => m.id)).not.toContain("photos");
    });

    it("offers nothing at all once every app has content", () => {
      expect(homeFirstMoves([])).toStrictEqual([]);
    });

    it("every move is a real door, and every one is verb-first", () => {
      for (const move of homeFirstMoves(tilesOf({}), 99)) {
        expect(move.label.length, `${move.id} label`).toBeGreaterThan(0);
        expect(move.hint.length, `${move.id} hint`).toBeGreaterThan(0);
        expect(["app", "connectors"]).toContain(move.kind);
      }
    });
  });
});
