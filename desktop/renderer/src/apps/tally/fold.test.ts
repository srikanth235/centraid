import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  asInteger,
  blobUrl,
  byColumn,
  foldDashboard,
  foldPhotos,
} from "./fold.js";
import type { Page } from "./fold.js";

const CONTRACTS = path.resolve(import.meta.dirname, "../../../../../contracts");

interface Fixture {
  table: string;
  columns: string[];
  rows: unknown[][];
}

const rowsFixture = (): Record<string, Fixture> =>
  JSON.parse(
    fs.readFileSync(path.join(CONTRACTS, "apps/tally/rows.json"), "utf8")
  ) as Record<string, Fixture>;

const queriesFixture = (): Array<{
  input: unknown;
  output: Record<string, unknown>;
}> =>
  JSON.parse(
    fs.readFileSync(path.join(CONTRACTS, "apps/tally/queries.json"), "utf8")
  ) as Array<{ input: unknown; output: Record<string, unknown> }>;

const catalogue = (): {
  local_protocol_version: number;
  statements: Array<{
    name: string;
    select: string[];
    from: string;
    where: string | null;
    sort_column: string;
    pk_column: string;
    descending: boolean;
  }>;
} =>
  JSON.parse(
    fs.readFileSync(
      path.join(CONTRACTS, "desktop/socket-catalogue.json"),
      "utf8"
    )
  );

/**
 * Build the page the seat WOULD serve for one catalogue statement, out of the
 * fixture's rows.
 *
 * The projection and the `WHERE` come from the committed catalogue rather than
 * being retyped here — so a statement whose `select` changes changes this
 * harness too, and the fold is compared against the columns it will really be
 * handed. Only the two predicates the Tally statements actually use are
 * implemented, and an unrecognised one throws rather than being ignored: a
 * silently-unfiltered page would make the counts below pass for the wrong
 * reason.
 */
function pageFor(name: string): Page {
  const statement = catalogue().statements.find((entry) => entry.name === name);
  if (!statement) throw new Error(`${name} is not in the committed catalogue`);
  const fixture = Object.values(rowsFixture()).find(
    (entry) => entry.table === statement.from
  );
  if (!fixture) throw new Error(`the fixture has no ${statement.from}`);
  const keep = (row: unknown[]): boolean => {
    const at = (column: string): unknown => {
      const index = fixture.columns.indexOf(column);
      return index < 0 ? undefined : row[index];
    };
    switch (statement.where) {
      case null:
        return true;
      case "deleted_at IS NULL":
        return at("deleted_at") === null || at("deleted_at") === undefined;
      case "settled_at IS NULL AND deleted_at IS NULL":
        return (
          (at("settled_at") === null || at("settled_at") === undefined) &&
          (at("deleted_at") === null || at("deleted_at") === undefined)
        );
      case "archived_at IS NULL AND deleted_at IS NULL":
        return (
          (at("archived_at") === null || at("archived_at") === undefined) &&
          (at("deleted_at") === null || at("deleted_at") === undefined)
        );
      case "target_type = ? AND role = ?":
        return (
          at("target_type") === "tally.expense" && at("role") === "receipt"
        );
      default:
        throw new Error(
          `this harness does not implement \`${statement.where}\``
        );
    }
  };
  return {
    columns: statement.select,
    rows: fixture.rows.filter(keep).map((row) =>
      statement.select.map((column) => {
        const index = fixture.columns.indexOf(column);
        if (index < 0) throw new Error(`${statement.from} has no ${column}`);
        return row[index];
      })
    ),
  };
}

describe("positional rows", () => {
  it("are keyed by the statement's own select, never by an index literal", () => {
    const page: Page = {
      columns: ["group_id", "currency"],
      rows: [["id-1", "GBP"]],
    };
    expect(byColumn(page)).toStrictEqual([
      { group_id: "id-1", currency: "GBP" },
    ]);
    expect(byColumn(undefined)).toStrictEqual([]);
  });

  it("keeps `no such column` distinguishable from SQL NULL", () => {
    const page: Page = { columns: ["a", "b"], rows: [[null]] };
    const [keyed] = byColumn(page);
    expect("a" in keyed!).toBe(true);
    expect(keyed!["a"]).toBeNull();
    // `b` was never carried, so it is ABSENT rather than null.
    expect("b" in keyed!).toBe(false);
  });

  it("reads a large integer out of its decimal-string escape", () => {
    expect(asInteger(42)).toBe(42);
    expect(asInteger({ i: "9007199254740993" })).toBe(9007199254740992);
    expect(asInteger(null)).toBeUndefined();
    expect(asInteger("42")).toBeUndefined();
    expect(asInteger({ b64: "AQID" })).toBeUndefined();
  });
});

/**
 * PARITY, against `contracts/apps/tally/queries.json` case 0 — the dashboard
 * with no input.
 *
 * What is compared is the half the renderer owns: the presentation JOIN. The
 * arithmetic half (who owes whom) is `crates/apps/tally`'s balance engine and
 * is already compared against `balances.json` by `crates/apps/tally/tests/
 * parity.rs`; that test deliberately does NOT compare `queries.json` because
 * its outputs carry presentation the port had no source for (its own header
 * says so). This is that source, so these fields can be compared now.
 */
describe("the dashboard, against v0's own answer", () => {
  const expected = queriesFixture()[0]!.output;
  const folded = foldDashboard({
    vault: pageFor("tally.vault"),
    friends: pageFor("tally.friends"),
    groups: pageFor("tally.groups"),
    circles: pageFor("tally.circles"),
    circleMembers: pageFor("tally.circleMembers"),
    expenses: pageFor("tally.expenses"),
    settlements: pageFor("tally.settlements"),
    obligations: pageFor("tally.obligations"),
  });

  it("agrees on the base currency", () => {
    expect(folded.baseCurrency).toBe(expected["currency"]);
  });

  it("agrees on the friend count", () => {
    expect(folded.friendCount).toBe((expected["friends"] as unknown[]).length);
  });

  it("agrees on the expense count, which excludes the trashed one", () => {
    // Seven rows in the fixture, six on the dashboard: `deleted_at IS NULL` is
    // in the statement, so the count is right because the FILTER is right.
    expect(folded.expenseCount).toBe(expected["expense_count"]);
    expect(rowsFixture()["14"]!.rows).toHaveLength(7);
  });

  it("agrees on the settlement count", () => {
    expect(folded.settlementCount).toBe(expected["settlement_count"]);
  });

  /**
   * Joined BY NAME and not by id, and that is a finding rather than a
   * convenience: `rows.json` and `queries.json` were generated from two
   * different fixture runs, so their generated ids disagree —
   * `rows.json`'s groups are `id-0033`, `id-0034`, `id-0011` while
   * `queries.json`'s are `id-0005`, `id-0006`, `id-0007`. Every other field
   * agrees, which is what makes the disagreement an id-sequence artefact and
   * not two different vaults. Recorded in the receipt for the fixture
   * generator to make one run.
   */
  it("agrees on every group's name, icon, currency and member count", () => {
    const expectedGroups = expected["groups"] as Array<Record<string, unknown>>;
    expect(folded.groups).toHaveLength(expectedGroups.length);
    const byName = new Map(folded.groups.map((group) => [group.name, group]));
    expect(byName.size).toBe(expectedGroups.length);
    for (const group of expectedGroups) {
      const mine = byName.get(group["name"] as string);
      expect(mine, `group ${String(group["name"])}`).toBeDefined();
      expect(mine!.icon).toBe(group["icon"]);
      expect(mine!.memberCount).toBe(group["member_count"]);
      // #996 R22 — a group is one ledger in one money, and v0's own answer
      // carries the currency inside `owner_net`.
      expect(mine!.currency).toBe(
        (group["owner_net"] as Record<string, unknown>)["currency"]
      );
      // Every group in this fixture has an id, even though the two fixtures'
      // id sequences disagree.
      expect(mine!.groupId).toMatch(/^id-\d{4}$/u);
    }
  });

  it("agrees that nothing is archived in this fixture", () => {
    expect(folded.archivedGroupCount).toBe(
      (expected["archived_groups"] as unknown[]).length
    );
  });

  it("says when it did not read all of the ledger", () => {
    expect(folded.truncated).toBe(false);
    const cut = {
      ...pageFor("tally.expenses"),
      next: { sort_key: "2026-01-01", pk: "id-0100" },
    };
    expect(foldDashboard({ expenses: cut }).truncated).toBe(true);
  });
});

describe("the photos grid", () => {
  const page = (columns: string[], rows: unknown[][]): Page => ({
    columns,
    rows,
  });

  it("joins three pages into tiles and mints one centraid:// url each", () => {
    const digest = "b".repeat(64);
    const tiles = foldPhotos({
      assets: page(
        [
          "asset_id",
          "content_id",
          "kind",
          "title",
          "captured_at",
          "width",
          "height",
          "duration_s",
        ],
        [
          [
            "a-1",
            "c-1",
            "video",
            "Beach",
            "2026-01-02T03:04:05Z",
            1920,
            1080,
            12.5,
          ],
        ]
      ),
      content: page(
        ["content_id", "sha256", "byte_size"],
        [["c-1", digest, 4096]]
      ),
      representations: page(
        ["representation_id", "content_id", "media_type"],
        [
          ["r-1", "c-1", "video/mp4"],
          // A SECOND representation of the same bytes is an alternative
          // rendition, not an override: the first one the statement ordered
          // wins.
          ["r-2", "c-1", "image/jpeg"],
        ]
      ),
    });
    expect(tiles).toStrictEqual([
      {
        assetId: "a-1",
        contentId: "c-1",
        kind: "video",
        title: "Beach",
        capturedAt: "2026-01-02T03:04:05Z",
        src: `centraid://blob/${digest}`,
        mediaType: "video/mp4",
        width: 1920,
        height: 1080,
        durationSeconds: 12.5,
      },
    ]);
  });

  it("has no src for an asset whose bytes are not known yet, rather than a broken url", () => {
    const [tile] = foldPhotos({
      assets: page(
        ["asset_id", "content_id", "kind"],
        [["a-1", "c-missing", "photo"]]
      ),
      content: page(["content_id", "sha256"], []),
    });
    expect(tile!.src).toBeUndefined();
  });

  it("refuses to build a url from anything that is not a digest", () => {
    const digest = "c".repeat(64);
    expect(blobUrl(digest)).toBe(`centraid://blob/${digest}`);
    expect(blobUrl(digest, { download: true })).toBe(
      `centraid://blob/${digest}?download=1`
    );
    for (const bad of ["", "abc", "../../etc/passwd", "g".repeat(64)]) {
      expect(() => blobUrl(bad), bad).toThrow(/not a blob digest/u);
    }
  });
});

describe("the committed catalogue", () => {
  it("carries every statement the dashboard and the grid read", () => {
    const names = new Set(catalogue().statements.map((entry) => entry.name));
    for (const needed of [
      "tally.vault",
      "tally.friends",
      "tally.groups",
      "tally.circles",
      "tally.circleMembers",
      "tally.expenses",
      "tally.settlements",
      "tally.obligations",
      "photos.assets",
      "photos.content",
      "photos.representations",
    ]) {
      expect(names.has(needed), needed).toBe(true);
    }
  });

  it("agrees with the shell on the local protocol version", () => {
    expect(catalogue().local_protocol_version).toBe(1);
  });
});
