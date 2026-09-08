// The seat-agnostic half of the person screen's grant dashboard (#825, #880).
//
// One claim, four ways: a read that did not come back is never flattened into
// "nothing is shared". The 404 is an answer, a refusal keeps the route's own
// words, and a gateway nothing reached degrades to ABSENT (L-read).
import { describe, expect, test } from "vitest";

import {
  GRANTS_UNREACHABLE,
  GRANTS_UNREADABLE,
} from "../_shared/grant-copy.ts";
import { GrantUnreachableError } from "../_shared/grant-door.ts";
import type { GrantDoor } from "../_shared/grant-door.ts";
import type { GrantRecord } from "../_shared/grant-plane.ts";
import { readPartyGrants } from "./grant-dashboard.ts";

function grant(overrides: Partial<GrantRecord> = {}): GrantRecord {
  return {
    grantId: "grant-1",
    audience: { kind: "party", id: "party-priya" },
    subjectType: "core.document",
    subjectId: "doc-1",
    capability: "view",
    grantedAt: "2026-08-01T10:00:00.000Z",
    revokedAt: null,
    grantedBy: "party-owner",
    maxSizeBytes: null,
    fulfillment: [],
    // The vault's own words for where it stands (ruling V-phrases).
    phrase: "on its way",
    reason: "no vault has been addressed for it yet",
    ...overrides,
  };
}

function stubDoor(overrides: Partial<GrantDoor> = {}): GrantDoor {
  return {
    subjects: () => Promise.resolve({ readable: true, offers: [] }),
    forParty: () =>
      Promise.resolve({
        known: true,
        channel: { state: "live" as const },
        grants: [grant()],
      }),
    forAudience: () => Promise.resolve({ known: true, grants: [] }),
    forSubject: () => Promise.resolve([]),
    create: () => Promise.resolve({ ok: true, outcome: "created" as const }),
    revoke: () => Promise.resolve({ ok: true, message: "no longer shared" }),
    changeCapability: () =>
      Promise.resolve({ ok: true, outcome: "created" as const }),
    ...overrides,
  };
}

describe("reading one person's standing grants", () => {
  test("a read that answered carries the reach and the live grants", async () => {
    const state = await readPartyGrants(
      stubDoor({
        forParty: () =>
          Promise.resolve({
            known: true,
            channel: { state: "severed" as const },
            grants: [grant(), grant({ grantId: "grant-2", revokedAt: "2026" })],
          }),
      }),
      "party-priya"
    );
    expect(state).toStrictEqual({
      kind: "read",
      reach: "severed",
      grants: [grant()],
    });
  });

  test("the 404 is a party this vault has no record of, not an empty share list", async () => {
    const state = await readPartyGrants(
      stubDoor({
        forParty: () =>
          Promise.resolve({ known: false, channel: undefined, grants: [] }),
      }),
      "party-priya"
    );
    expect(state).toStrictEqual({ kind: "unknown-party" });
  });

  test("a gateway that refused keeps its own words", async () => {
    const state = await readPartyGrants(
      stubDoor({
        forParty: () =>
          Promise.reject(new Error("the vault refused that read")),
      }),
      "party-priya"
    );
    expect(state).toStrictEqual({
      kind: "refused",
      message: "the vault refused that read",
    });
  });

  test("a refusal with nothing to quote falls back to the read sentence", async () => {
    const state = await readPartyGrants(
      stubDoor({ forParty: () => Promise.reject(new Error("   ")) }),
      "party-priya"
    );
    expect(state).toStrictEqual({
      kind: "refused",
      message: GRANTS_UNREADABLE,
    });
  });

  test("a gateway nothing reached is absent, not refused and not empty", async () => {
    // `unavailable` draws no count and no rows, so a phone off the network
    // cannot read as "nothing is shared" or as a vault that said no.
    const state = await readPartyGrants(
      stubDoor({
        forParty: () =>
          Promise.reject(
            new GrantUnreachableError("read what this person can reach")
          ),
      }),
      "party-priya"
    );
    expect(state).toStrictEqual({
      kind: "unavailable",
      message: GRANTS_UNREACHABLE,
    });
  });
});
