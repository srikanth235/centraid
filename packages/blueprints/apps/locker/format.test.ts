import { describe, expect, it } from "vitest";

import {
  OPEN_ITEM,
  byTitle,
  matchesCheck,
  metaSentence,
  needsReview,
  primarySealedField,
  purgeCountdown,
  rowsFor,
  showsWindowEnd,
  tagCounts,
  typeChip,
  typeCounts,
  typeLabel,
  verdictOf,
  windowEndCopy,
} from "./format.ts";
import type { LockerRow } from "./types.ts";
import { WINDOW_RULE } from "./view-copy.ts";

const row = (over: Partial<LockerRow> & { item_id: string }): LockerRow => ({
  type: "login",
  title: over.item_id,
  ...over,
});

const WINDOW: LockerRow[] = [
  row({
    item_id: "github",
    title: "GitHub",
    subtitle: "ana@x.test",
    tags: ["work"],
    favorite: true,
  }),
  row({
    item_id: "forum",
    title: "The old forum",
    subtitle: "ana",
    weak: true,
  }),
  row({
    item_id: "store",
    title: "Storage portal",
    subtitle: "ana@x.test",
    reused: true,
    tags: ["house"],
  }),
  row({
    item_id: "ch",
    title: "Companies House",
    subtitle: "ana@x.test",
    compromised: true,
    weak: true,
  }),
  row({
    item_id: "card",
    type: "card",
    title: "Barclaycard",
    subtitle: "•••• 4417",
    tags: ["money"],
  }),
  row({
    item_id: "wifi",
    type: "wifi",
    title: "Sitwell Road",
    subtitle: "SITWELL-5G",
    tags: ["house"],
  }),
];

describe("the type chip and the meta sentence", () => {
  it("marks a type with two letters of its own word", () => {
    expect(typeChip("login")).toBe("LO");
    expect(typeChip("card")).toBe("CA");
    expect(typeChip("note")).toBe("SE");
    expect(typeChip("wifi")).toBe("WI");
  });

  it("degrades an unknown type to an item rather than to nothing", () => {
    expect(typeLabel("ssh-key")).toBe("Item");
  });

  it("reads type · subtitle · tags, and drops what is absent", () => {
    expect(metaSentence(WINDOW[0] as LockerRow)).toBe(
      "Login  ·  ana@x.test  ·  #work"
    );
    expect(metaSentence(row({ item_id: "bare" }))).toBe("Login");
  });

  it("never draws the query's own em-dash placeholder as a fact", () => {
    expect(metaSentence(row({ item_id: "x", subtitle: "—" }))).toBe("Login");
  });

  it("renders member text inert — a control character never reaches the DOM", () => {
    const sentence = metaSentence(row({ item_id: "x", subtitle: "ana‮exe" }));
    expect(sentence).not.toContain("‮");
  });
});

describe("one verdict per row, and compromised outranks the rest", () => {
  it("takes --net for compromised even when the row is also weak", () => {
    expect(verdictOf(WINDOW[3] as LockerRow)).toStrictEqual({
      label: "COMPROMISED",
      tone: "net",
    });
  });

  it("takes the seam for reused and weak", () => {
    expect(verdictOf(WINDOW[2] as LockerRow)?.tone).toBe("seam");
    expect(verdictOf(WINDOW[1] as LockerRow)).toStrictEqual({
      label: "WEAK",
      tone: "seam",
    });
  });

  it("draws no chip at all where there is no verdict", () => {
    expect(verdictOf(WINDOW[4] as LockerRow)).toBeNull();
  });

  it("agrees with the review's own membership", () => {
    expect(WINDOW.filter(needsReview).map((r) => r.item_id)).toStrictEqual([
      "forum",
      "store",
      "ch",
    ]);
  });
});

describe("a filter is the same set under a lens", () => {
  it("shows everything, by title", () => {
    expect(rowsFor(WINDOW, { kind: "all" }).map((r) => r.title)).toStrictEqual(
      WINDOW.map((r) => r.title).toSorted((a, b) => a.localeCompare(b))
    );
  });

  it.each([
    [{ kind: "starred" } as const, ["github"]],
    [{ kind: "review" } as const, ["ch", "store", "forum"]],
    [{ kind: "type", type: "card" } as const, ["card"]],
    [{ kind: "tag", tag: "house" } as const, ["store", "wifi"]],
  ])("%o selects its own rows", (filter, expected) => {
    expect(
      rowsFor(WINDOW, filter)
        .map((r) => r.item_id)
        .toSorted()
    ).toStrictEqual(expected.toSorted());
  });

  it("counts every type, drawing a zero as a zero", () => {
    expect(typeCounts(WINDOW)).toStrictEqual({
      login: 4,
      card: 1,
      note: 0,
      identity: 0,
      wifi: 1,
      password: 0,
    });
  });

  it("counts the tag vocabulary present in the window, alphabetically", () => {
    expect(tagCounts(WINDOW)).toStrictEqual([
      { tag: "house", count: 2 },
      { tag: "money", count: 1 },
      { tag: "work", count: 1 },
    ]);
  });

  it("orders rows by title everywhere", () => {
    expect(
      byTitle(
        row({ item_id: "a", title: "Alpha" }),
        row({ item_id: "b", title: "Beta" })
      )
    ).toBeLessThan(0);
  });
});

describe("the window's foot is honest about what it does not know", () => {
  it("keeps the rule verbatim in both readings", () => {
    expect(windowEndCopy(300, true)).toContain(WINDOW_RULE);
    expect(windowEndCopy(12, false)).toContain(WINDOW_RULE);
  });

  it("says older items exist rather than inventing a total", () => {
    expect(windowEndCopy(300, true)).toContain("300 shown");
    expect(windowEndCopy(300, true)).not.toMatch(/of \d+/u);
    expect(windowEndCopy(12, false)).toContain("12 in the vault");
  });

  it("draws no foot under a set nobody read, or an empty one", () => {
    expect(showsWindowEnd(false, 10)).toBe(false);
    expect(showsWindowEnd(true, 0)).toBe(false);
    expect(showsWindowEnd(true, 10)).toBe(true);
  });
});

describe("a permit is minted against the field the TYPE seals", () => {
  it.each([
    ["login", "password"],
    ["password", "password"],
    ["wifi", "password"],
    ["card", "card_number"],
    ["note", "content"],
  ])("%s is asked for its %s", (type, field) => {
    expect(primarySealedField(type)).toBe(field);
  });

  it("asks an identity for the READ, because it seals nothing", () => {
    expect(primarySealedField("identity")).toBe(OPEN_ITEM);
  });

  it("falls back to a password for a type the vault gains later", () => {
    expect(primarySealedField("ssh-key")).toBe("password");
  });
});

describe("the trash row counts down rather than stating a date", () => {
  const inDays = (days: number): string =>
    new Date(Date.now() + days * 86_400_000).toISOString();

  it("says how long is left, in the words the drive uses", () => {
    expect(purgeCountdown(inDays(22))).toBe("purges in 22 days");
    expect(purgeCountdown(inDays(0.5))).toBe("purges tomorrow");
    expect(purgeCountdown(inDays(-1))).toBe("purges today");
  });

  it("SAYS NOTHING where the vault has scheduled nothing", () => {
    expect(purgeCountdown(null)).toBe("");
    expect(purgeCountdown(undefined)).toBe("");
    expect(purgeCountdown("not a date")).toBe("");
  });
});

describe("the verdict lens answers the count that was pressed", () => {
  const NOW = Date.now();
  const flagged: LockerRow[] = [
    row({ item_id: "a", weak: true }),
    row({ item_id: "b", reused: true }),
    row({ item_id: "c", compromised: true }),
    row({ item_id: "d", url: "http://plain.example" }),
  ];

  it.each([
    ["weak", ["a"]],
    ["reused", ["b"]],
    ["compromised", ["c"]],
    ["http", ["d"]],
  ] as const)("%s opens exactly its own rows", (check, expected) => {
    expect(
      rowsFor(flagged, { kind: "verdict", check }).map((each) => each.item_id)
    ).toStrictEqual([...expected]);
  });

  it("is the same derivation the register counted with", () => {
    for (const each of flagged) {
      expect(matchesCheck(each, "weak", NOW)).toBe(Boolean(each.weak));
    }
  });

  it("leaves the review lens as every flagged row, whatever the check", () => {
    expect(rowsFor(flagged, { kind: "review" })).toHaveLength(3);
  });
});
