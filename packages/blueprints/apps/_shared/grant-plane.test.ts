// The grant plane's reading law (#825).
//
// Three claims, and they are the ones that keep a sheet from lying about a
// share:
//
//  1. ABSENT IS NEVER EMPTY. A grant addressed to nobody, a vault that has
//     never reached a person, and a severed link answer three different
//     tokens — none of them is allowed to arrive wearing another's clothes.
//  2. THE REGISTRY DECIDES THE VERBS. `edit` exists only where the gateway's
//     declared registry answers it; an unreadable registry offers nothing
//     rather than everything.
//  3. THE WIRE IS UNTRUSTED. A drifted row is dropped, never half-rendered.
import { describe, expect, test } from "vitest";

import {
  capabilitiesFor,
  channelReach,
  defaultCapability,
  drawableCapability,
  grantDelivery,
  grantOverSubject,
  grantRequestFor,
  liveGrants,
  offersCapability,
  parseChannel,
  parseGrant,
  parseGrants,
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
      { subjectType: "core.document", capabilities: ["view", "edit"] },
      { subjectType: "media.asset", capabilities: ["view"] },
      { subjectType: "broken.thing", capabilities: ["comment"] },
    ]);
    expect(offers.map((offer) => offer.subjectType)).toStrictEqual([
      "core.document",
      "media.asset",
    ]);
    expect(parseSubjectOffers(undefined)).toStrictEqual([]);
  });
});

describe("absent is never empty", () => {
  test("no delivery row is its own answer, not a failed delivery", () => {
    expect(grantDelivery(grant({ fulfillment: [] }))).toBe("none");
  });

  test("a grant half delivered and half waiting reads as still owed", () => {
    const mixed = grant({
      fulfillment: [
        { peerVaultId: "a", state: "delivered", updatedAt: "", detail: null },
        {
          peerVaultId: "b",
          state: "awaiting_channel",
          updatedAt: "",
          detail: null,
        },
      ],
    });
    expect(grantDelivery(mixed)).toBe("awaiting_channel");
  });

  test("never reached, invited and severed are three different facts", () => {
    expect(channelReach(parseChannel(null))).toBe("never-reached");
    expect(channelReach(parseChannel({ state: "invited" }))).toBe("invited");
    expect(
      channelReach(parseChannel({ state: "severed", vaultId: "vault-priya" }))
    ).toBe("severed");
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
    { subjectType: "core.document", capabilities: ["view", "edit"] },
    { subjectType: "media.asset", capabilities: ["view"] },
  ]);

  test("edit is offered only where a strategy answers it", () => {
    expect(offersCapability(offers, "core.document", "edit")).toBe(true);
    expect(offersCapability(offers, "media.asset", "edit")).toBe(false);
  });

  test("a subject the registry does not name is refused, not defaulted open", () => {
    expect(capabilitiesFor(offers, "locker.item")).toStrictEqual([]);
    expect(offersCapability(offers, "locker.item", "view")).toBe(false);
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
