import { afterEach, describe, expect, test } from "vitest";

import {
  grantAudiencesFrom,
  readGrantAudiences,
  ROSTER_UNREADABLE,
} from "./grant-audiences.ts";

describe("grant audiences — one roster mapping for every app", () => {
  test("names people by party, then named circles with their size", () => {
    expect(
      grantAudiencesFrom(
        [
          { label: "Ravi", partyId: "party-ravi" },
          { label: "Asha", partyId: "party-asha" },
        ],
        [{ circleId: "circle-1", label: "Ski trip", members: [{}, {}, {}] }]
      )
    ).toStrictEqual([
      { kind: "party", id: "party-ravi", label: "Ravi" },
      { kind: "party", id: "party-asha", label: "Asha" },
      { kind: "circle", id: "circle-1", label: "Ski trip", memberCount: 3 },
    ]);
  });

  test("a destination with no party names a vault, not a person, and is dropped", () => {
    expect(grantAudiencesFrom([{ label: "Linked vault" }], [])).toStrictEqual(
      []
    );
  });

  test("a person queued offline is never offered", () => {
    expect(
      grantAudiencesFrom(
        [{ label: "Offline friend", partyId: "pending:intent-1:0" }],
        []
      )
    ).toStrictEqual([]);
  });

  test("an empty roster is a real answer, not a failure", () => {
    expect(grantAudiencesFrom([], [])).toStrictEqual([]);
  });

  test("the native seat's own pending flag is honoured beside the id form", () => {
    expect(
      grantAudiencesFrom(
        [
          { label: "Queued", partyId: "party-real", pending: true },
          { label: "Settled", partyId: "party-real-2", pending: false },
        ],
        []
      )
    ).toStrictEqual([{ kind: "party", id: "party-real-2", label: "Settled" }]);
  });
});

describe("reading the roster — unreadable is not empty", () => {
  const stub = (centraid: Record<string, unknown>): void => {
    (globalThis as { window?: unknown }).window = { centraid };
  };

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  test("a roster that answered is `ok`, with the mapping applied", async () => {
    stub({
      shareTargets: () =>
        Promise.resolve([{ partyId: "party-asha", label: "Asha" }]),
      shareCircles: () => Promise.resolve([]),
      scopes: [],
    });
    await expect(readGrantAudiences()).resolves.toStrictEqual({
      ok: true,
      audiences: [{ kind: "party", id: "party-asha", label: "Asha" }],
    });
  });

  test("a roster that answered NOBODY is still `ok` — an empty answer is one", async () => {
    stub({
      shareTargets: () => Promise.resolve([]),
      shareCircles: () => Promise.resolve([]),
      scopes: [],
    });
    await expect(readGrantAudiences()).resolves.toStrictEqual({
      ok: true,
      audiences: [],
    });
  });

  test("a People read that FAILED is not `ok`, and never passes as empty", async () => {
    stub({
      shareTargets: () => Promise.reject(new Error("gateway gone")),
      shareCircles: () => Promise.resolve([]),
      scopes: [],
    });
    await expect(readGrantAudiences()).resolves.toStrictEqual({ ok: false });
  });

  test("a circles read that failed takes the whole roster with it", async () => {
    stub({
      shareTargets: () =>
        Promise.resolve([{ partyId: "party-asha", label: "Asha" }]),
      shareCircles: () => Promise.reject(new Error("gateway gone")),
      scopes: [],
    });
    await expect(readGrantAudiences()).resolves.toStrictEqual({ ok: false });
  });

  test("the unreadable sentence blames the read, never the member", () => {
    expect(ROSTER_UNREADABLE).toContain("could not be read");
    expect(ROSTER_UNREADABLE).not.toContain("nobody");
  });
});
