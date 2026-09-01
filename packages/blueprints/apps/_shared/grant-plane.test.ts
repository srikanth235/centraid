// The grant plane's reading law (#825, #883): absent is never empty, the
// registry decides the verbs, the wire is untrusted, and the vault says where
// a grant stands. Each test below is the statement of one of them.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  capabilitiesFor,
  channelReach,
  reachBlocksSharing,
  defaultCapability,
  drawableCapability,
  GRANT_LOCI,
  GRANT_PHRASES,
  grantOverSubject,
  grantRequestFor,
  liveGrants,
  parseChannel,
  parseGrant,
  parseGrants,
  parseLoci,
  parseSubjectOffers,
  subjectNoun,
} from "./grant-plane.ts";
import type { GrantRecord } from "./grant-plane.ts";

const WIRE_GRANT = {
  grantId: "grant-1",
  audience: { kind: "party", id: "party-priya" },
  subjectType: "core.document",
  subjectId: "doc-1",
  capability: "view",
  grantedAt: "2026-08-01T10:00:00.000Z",
  revokedAt: null,
  grantedBy: "party-owner",
  maxSizeBytes: null,
  fulfillment: [
    {
      grantId: "grant-1",
      peerVaultId: "vault-priya",
      state: "delivered",
      updatedAt: "2026-08-01T10:00:01.000Z",
      detail: null,
    },
  ],
};

function grant(overrides: Partial<GrantRecord> = {}): GrantRecord {
  return { ...parseGrant(WIRE_GRANT)!, ...overrides };
}

describe("the vault's own words", () => {
  /** A source scan, not an import: blueprints cannot import `@centraid/vault`
   *  (Node-only), which is why `GRANT_PHRASES` is mirrored here at all. */
  test("the phrase union is exactly the vault's, in the vault's order", () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, "../../../vault/src/grant/phrases.ts"),
      "utf8"
    );
    const declaration = /const GRANT_PHRASES = \[(?<body>[^\]]*)\]/u.exec(
      source
    );
    const vaultPhrases = [
      ...(declaration?.groups?.body ?? "").matchAll(/"(?<phrase>[^"]+)"/gu),
    ].map((match) => match.groups!.phrase!);
    expect(vaultPhrases.length).toBeGreaterThan(0);
    expect([...GRANT_PHRASES]).toStrictEqual(vaultPhrases);
  });

  test("the locus union is exactly the vault's three", () => {
    // Same reason as the phrases: a fourth locus in the vault must not be
    // silently unparseable here.
    const source = readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../../vault/src/grant/authority-registry.ts"
      ),
      "utf8"
    );
    const declaration = /export type EnforcementLocus =(?<body>[^;]*);/u.exec(
      source
    );
    const vaultLoci = [
      ...(declaration?.groups?.body ?? "").matchAll(/"(?<locus>[a-z]+)"/gu),
    ].map((match) => match.groups!.locus!);
    expect(vaultLoci.length).toBeGreaterThan(0);
    expect([...GRANT_LOCI].toSorted()).toStrictEqual(vaultLoci.toSorted());
  });

  test("the locus and its promise ride the wire, or nothing is claimed", () => {
    const carried = parseGrant({
      ...WIRE_GRANT,
      locus: "remote",
      promise: "their vault is asked to remove its copy",
    });
    expect(carried?.locus).toBe("remote");
    expect(carried?.promise).toBe("their vault is asked to remove its copy");

    // A wire that said nothing leaves both absent — a surface may not promise
    // on the vault's behalf.
    const silent = parseGrant({ ...WIRE_GRANT, locus: "elsewhere" });
    expect(silent?.locus).toBeUndefined();
    expect(silent?.promise).toBeUndefined();

    expect(
      parseLoci({ boundary: "refused at the door", remote: "" })
    ).toStrictEqual({
      boundary: "refused at the door",
    });
    expect(parseLoci(null)).toStrictEqual({});
  });

  test("the phrase and its reason ride the wire; a drifted phrase is unstated", () => {
    const standing = parseGrant({
      ...WIRE_GRANT,
      phrase: "shared",
      reason: "the vault it addresses is holding it",
    });
    expect(standing?.phrase).toBe("shared");
    expect(standing?.reason).toBe("the vault it addresses is holding it");

    // A word this seat does not know is NOT rounded to a neighbouring one: the
    // three phrases are not interchangeable, so the row simply does not say.
    const drifted = parseGrant({ ...WIRE_GRANT, phrase: "half-shared" });
    expect(drifted?.phrase).toBeUndefined();
    expect(drifted?.grantId).toBe("grant-1");
    // And a wire that said nothing at all leaves both unstated.
    expect(parseGrant(WIRE_GRANT)?.phrase).toBeUndefined();
    expect(parseGrant(WIRE_GRANT)?.reason).toBeNull();
  });

  test("a withdrawal is asked until the audience confirms it", () => {
    const asked = parseGrant({
      ...WIRE_GRANT,
      revokedAt: "2026-08-02T10:00:00.000Z",
      phrase: "withdrawn",
      confirmed: false,
      reason: "a vault holding a copy has been asked to remove it",
    });
    expect(asked?.confirmed).toBe(false);
    const settled = parseGrant({
      ...WIRE_GRANT,
      revokedAt: "2026-08-02T10:00:00.000Z",
      phrase: "withdrawn",
      confirmed: true,
    });
    expect(settled?.confirmed).toBe(true);
    // Absent is not `false`: unstated and "not yet confirmed" are two facts.
    expect(
      parseGrant({ ...WIRE_GRANT, phrase: "withdrawn" })?.confirmed
    ).toBeUndefined();
  });
});

describe("parsing the grant wire", () => {
  test("a complete grant survives with its delivery rows", () => {
    const parsed = parseGrant(WIRE_GRANT);
    expect(parsed?.grantId).toBe("grant-1");
    expect(parsed?.audience).toStrictEqual({
      kind: "party",
      id: "party-priya",
    });
    expect(parsed?.fulfillment).toStrictEqual([
      {
        peerVaultId: "vault-priya",
        state: "delivered",
        updatedAt: "2026-08-01T10:00:01.000Z",
        detail: null,
      },
    ]);
  });

  test("a drifted grant is dropped rather than rendered half-built", () => {
    expect(
      parseGrant({ ...WIRE_GRANT, capability: "comment" })
    ).toBeUndefined();
    expect(
      parseGrant({ ...WIRE_GRANT, audience: { kind: "team", id: "x" } })
    ).toBeUndefined();
    expect(parseGrant(null)).toBeUndefined();
    expect(parseGrants([WIRE_GRANT, { grantId: "" }])).toHaveLength(1);
  });

  test("a drifted delivery row is dropped without taking the grant with it", () => {
    const parsed = parseGrant({
      ...WIRE_GRANT,
      fulfillment: [
        { peerVaultId: "v", state: "invented" },
        WIRE_GRANT.fulfillment[0],
      ],
    });
    expect(parsed?.fulfillment).toHaveLength(1);
  });

  test("the registry is read from the wire, and an unreadable one offers nothing", () => {
    const offers = parseSubjectOffers([
      { subjectType: "tally.group", capabilities: ["view", "edit"] },
      { subjectType: "core.document", capabilities: ["view"] },
      { subjectType: "broken.thing", capabilities: ["comment"] },
    ]);
    expect(offers.map((offer) => offer.subjectType)).toStrictEqual([
      "tally.group",
      "core.document",
    ]);
    expect(parseSubjectOffers(undefined)).toStrictEqual([]);
  });
});

describe("absent is never empty", () => {
  test("never reached and severed are two different facts", () => {
    expect(channelReach(parseChannel(null))).toBe("never-reached");
    expect(
      channelReach(parseChannel({ state: "severed", vaultId: "vault-priya" }))
    ).toBe("severed");
    // A third state used to sit between them. `invited` meant a share had
    // minted a commons claim and was waiting for the person to arrive with a
    // vault; #903 retired that bootstrap, so the word is no longer a channel
    // and a wire still sending it is a READ that did not say.
    expect(channelReach(parseChannel({ state: "invited" }))).toBe("unknown");
  });

  test("only a live link makes the share verb performable", () => {
    // `unknown` must not block: "we could not look" is not "not linked", and
    // the route stays the authority either way.
    expect(reachBlocksSharing("live")).toBe(false);
    expect(reachBlocksSharing("unknown")).toBe(false);
    expect(reachBlocksSharing("never-reached")).toBe(true);
    expect(reachBlocksSharing("severed")).toBe(true);
  });

  test("a read that did not say is unknown, never the definite never-reached", () => {
    // Only an explicit `null` on the wire is the claim "we have never reached
    // them". An absent key or a drifted state is a fact about the READ.
    expect(channelReach(parseChannel(undefined))).toBe("unknown");
    expect(channelReach(parseChannel({}))).toBe("unknown");
    expect(channelReach(parseChannel({ state: "elsewhere" }))).toBe("unknown");
    expect(channelReach(parseChannel("live"))).toBe("unknown");
  });
});

describe("what the registry offers", () => {
  const offers = parseSubjectOffers([
    { subjectType: "tally.group", capabilities: ["view", "edit"] },
    { subjectType: "core.document", capabilities: ["view"] },
  ]);

  test("edit is offered only where a strategy answers it", () => {
    expect(capabilitiesFor(offers, "tally.group")).toStrictEqual([
      "view",
      "edit",
    ]);
    expect(capabilitiesFor(offers, "core.document")).toStrictEqual(["view"]);
  });

  test("a subject the registry does not name is refused, not defaulted open", () => {
    expect(capabilitiesFor(offers, "locker.item")).toStrictEqual([]);
  });

  test("the noun comes from the placement registry, never the wire spelling", () => {
    expect(subjectNoun("core.collection")).toBe("album");
    expect(subjectNoun("tally.group")).toBe("group");
    expect(subjectNoun("nothing.known")).toBe("shared item");
  });
});

describe("what the sheet proposes", () => {
  test("a revoked grant is history, not access", () => {
    const revoked = grant({ grantId: "grant-2", revokedAt: "2026-08-02" });
    expect(liveGrants([grant(), revoked])).toHaveLength(1);
  });

  const PRIYA = { kind: "party" as const, id: "party-priya" };
  const DOC = { subjectType: "core.document", subjectId: "doc-1" };

  test("a standing grant sets the capability the sheet opens on", () => {
    const standing = grant({ capability: "edit" });
    expect(defaultCapability(grantOverSubject([standing], DOC, PRIYA))).toBe(
      "edit"
    );
    expect(defaultCapability(undefined)).toBe("view");
  });

  test("a circle's edit does not widen a new grant to the person", () => {
    // `?partyId=` unions the grants naming Priya with the circle grants she
    // is on the roster of. A circle's `edit` is a decision about the CIRCLE.
    const circleEdit = grant({
      grantId: "grant-circle",
      audience: { kind: "circle", id: "circle-ski" },
      capability: "edit",
    });
    expect(grantOverSubject([circleEdit], DOC, PRIYA)).toBeUndefined();
    expect(defaultCapability(grantOverSubject([circleEdit], DOC, PRIYA))).toBe(
      "view"
    );
    expect(
      grantOverSubject([circleEdit], DOC, {
        kind: "circle",
        id: "circle-ski",
      })?.capability
    ).toBe("edit");
    expect(grantOverSubject([circleEdit], DOC, undefined)).toBeUndefined();
  });

  test("what Share submits is clamped to what the picker could draw", () => {
    // A subject the registry has since narrowed to view-only still carries
    // its old `edit` grant; a member cannot un-pick a verb never drawn.
    expect(drawableCapability(["view"], "edit")).toBe("view");
    expect(drawableCapability(["view", "edit"], "edit")).toBe("edit");
    expect(drawableCapability([], "edit")).toBe("view");
  });

  test("the request carries the subject label only when there is one", () => {
    const audience = {
      kind: "party" as const,
      id: "party-priya",
      label: "Priya",
    };
    expect(
      grantRequestFor(
        audience,
        {
          subjectType: "core.document",
          subjectId: "doc-1",
          label: "Trip plan",
        },
        "edit"
      )
    ).toStrictEqual({
      audienceKind: "party",
      audienceId: "party-priya",
      subjectType: "core.document",
      subjectId: "doc-1",
      capability: "edit",
      subjectLabel: "Trip plan",
    });
    expect(
      grantRequestFor(
        audience,
        { subjectType: "core.document", subjectId: "doc-1" },
        "view"
      ).subjectLabel
    ).toBeUndefined();
  });
});
