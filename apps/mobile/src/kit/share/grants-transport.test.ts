// The native seat's grant-plane transport (#825).
//
// Three claims, and each is about honesty rather than plumbing:
//
//  1. Paths come from the protocol package, and every read addresses the door
//     the route actually serves.
//  2. A refusal arrives as the ROUTE'S OWN message. `subject_not_offerable`
//     names the capabilities that subject does answer, and a transport error
//     in front of it would throw the useful half away.
//  3. An audience this vault has no record of is a real answer (`undefined`),
//     not a thrown failure — it is a different fact from an audience with
//     nothing shared.
import { afterEach, describe, expect, test, vi } from "vitest";

import { nativeGrantCalls, nativeGrantDoor } from "./grants-transport";

vi.mock(
  import("../../lib/gateway"),
  () => ({ apiHeaders: () => ({ Authorization: "Bearer test" }) }) as never
);

const BASE = "http://127.0.0.1:4599";

interface Call {
  url: string;
  method: string;
  body?: string;
}

function stubFetch(
  answer: (call: Call) => { status: number; body: unknown }
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (input: URL | string, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    };
    calls.push(call);
    const { status, body } = answer(call);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })
    );
  });
  return calls;
}

describe("the native grant transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  describe("addressing the grant plane", () => {
    test("each read asks the door the route serves", async () => {
      const calls = stubFetch(() => ({ status: 200, body: { grants: [] } }));
      const wire = nativeGrantCalls(BASE);
      await wire.subjects();
      await wire.forParty("party-priya");
      await wire.forSubject("core.document", "doc-1");
      await wire.create({
        audienceKind: "party",
        audienceId: "party-priya",
        subjectType: "core.document",
        subjectId: "doc-1",
        capability: "view",
      });
      await wire.revoke("grant 1");

      expect(calls.map((call) => call.url)).toStrictEqual([
        `${BASE}/centraid/_vault/grants/subjects`,
        `${BASE}/centraid/_vault/grants?partyId=party-priya`,
        `${BASE}/centraid/_vault/grants?subjectType=core.document&subjectId=doc-1`,
        `${BASE}/centraid/_vault/grants`,
        `${BASE}/centraid/_vault/grants/grant%201/revoke`,
      ]);
      expect(calls[3]?.method).toBe("POST");
      expect(JSON.parse(calls[3]?.body ?? "{}")).toMatchObject({
        capability: "view",
      });
    });

    test("an audience the vault has no record of answers undefined", async () => {
      stubFetch(() => ({ status: 404, body: { error: "audience_not_found" } }));
      await expect(
        nativeGrantCalls(BASE).forAudience("circle", "circle-1")
      ).resolves.toBeUndefined();
      const door = nativeGrantDoor(BASE);
      await expect(
        door.forAudience("circle", "circle-1")
      ).resolves.toStrictEqual({
        known: false,
        grants: [],
      });
    });

    test("a person the vault has no record of is an answer, not a read failure", async () => {
      // The primary read is `?partyId=`. Throwing here would make "we do not
      // know this person" arrive wearing "shares could not be read".
      stubFetch(() => ({
        status: 404,
        body: {
          error: "audience_not_found",
          message: "this vault knows no such person",
        },
      }));
      await expect(
        nativeGrantCalls(BASE).forParty("party-nobody")
      ).resolves.toBeUndefined();
      await expect(
        nativeGrantDoor(BASE).forParty("party-nobody")
      ).resolves.toStrictEqual({
        known: false,
        channel: undefined,
        grants: [],
      });
    });

    test("a party read that did not say leaves the channel unknown, never never-reached", async () => {
      stubFetch(() => ({ status: 200, body: { grants: [] } }));
      const reach = await nativeGrantDoor(BASE).forParty("party-priya");
      expect(reach).toStrictEqual({
        known: true,
        channel: undefined,
        grants: [],
      });
    });
  });

  describe("refusals keep the route's words", () => {
    test("a subject the vault cannot share is refused in its own terms", async () => {
      const message =
        "locker.item is not something this vault can share; nothing here can keep that grant true";
      stubFetch(() => ({
        status: 400,
        body: { error: "subject_not_offerable", message },
      }));
      const outcome = await nativeGrantDoor(BASE).create({
        audienceKind: "party",
        audienceId: "party-priya",
        subjectType: "locker.item",
        subjectId: "secret-1",
        capability: "view",
      });
      expect(outcome).toStrictEqual({ ok: false, message });
    });

    test("the revoke sentence is the route's, verbatim", async () => {
      const message =
        "no longer shared; a vault holding a copy has been asked to remove it and has not yet confirmed";
      stubFetch(() => ({
        status: 200,
        body: { outcome: "revoked", removal: {}, message },
      }));
      await expect(
        nativeGrantDoor(BASE).revoke("grant-1")
      ).resolves.toStrictEqual({ ok: true, message });
    });

    test("an unreadable registry offers nothing rather than everything, and says which", async () => {
      stubFetch(() => ({ status: 500, body: { error: "boom" } }));
      await expect(nativeGrantDoor(BASE).subjects()).resolves.toStrictEqual({
        readable: false,
        offers: [],
      });
    });

    test("a standing grant at another capability is not a silent success", async () => {
      // The route answers `exists` and leaves the capability alone. Reporting
      // that as "already shared" would report the widening as though it had
      // happened, which is the one thing a share sheet may never do.
      stubFetch(() => ({
        status: 200,
        body: {
          outcome: "exists",
          grant: {
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
          },
        },
      }));
      const outcome = await nativeGrantDoor(BASE).create({
        audienceKind: "party",
        audienceId: "party-priya",
        subjectType: "core.document",
        subjectId: "doc-1",
        capability: "edit",
      });
      expect(outcome).toMatchObject({
        ok: true,
        outcome: "exists_other_capability",
        standing: "view",
      });
    });

    test("the same capability standing is the ordinary already-shared success", async () => {
      stubFetch(() => ({
        status: 200,
        body: {
          outcome: "exists",
          grant: {
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
          },
        },
      }));
      const outcome = await nativeGrantDoor(BASE).create({
        audienceKind: "party",
        audienceId: "party-priya",
        subjectType: "core.document",
        subjectId: "doc-1",
        capability: "view",
      });
      expect(outcome).toMatchObject({ ok: true, outcome: "exists" });
    });
  });
});
