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
//  4. A REFUSAL IS NOT AN OUTAGE. `fetch` rejecting means the request never
//     left the phone and the gateway said nothing; a 4xx/5xx means it said
//     something. Same shape as the Tally read plane's pin
//     (`apps/mobile/src/apps/tally/tally-store.test.ts`) and the rule in
//     docs/mobile-offline.md: two facts, two sentences.
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  GRANT_FAILED,
  GRANT_UNREACHABLE,
  REGISTRY_UNREADABLE,
  REVOKE_FAILED,
  REVOKE_UNREACHABLE,
} from "@centraid/blueprints/apps/_shared/grant-copy";
import { isGrantUnreachable } from "@centraid/blueprints/apps/_shared/grant-door";

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
      expect(outcome).toStrictEqual({ ok: false, message, reach: "refused" });
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
        reach: "refused",
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

  describe("a gateway that never answered is not a gateway that said no", () => {
    /** What `fetch` does on a phone with no route to the host. */
    function offline(): void {
      vi.stubGlobal("fetch", () =>
        Promise.reject(new TypeError("Network request failed"))
      );
    }

    const REQUEST = {
      audienceKind: "party" as const,
      audienceId: "party-priya",
      subjectType: "core.document",
      subjectId: "doc-1",
      capability: "view" as const,
    };

    test("the transport marks the failure rather than leaving the door to guess", async () => {
      offline();
      await expect(nativeGrantCalls(BASE).create(REQUEST)).rejects.toSatisfy(
        isGrantUnreachable
      );
      // A gateway that ANSWERED is never marked, however unhappy the answer.
      stubFetch(() => ({ status: 500, body: { error: "boom" } }));
      await expect(
        nativeGrantCalls(BASE).create(REQUEST)
      ).rejects.not.toSatisfy(isGrantUnreachable);
    });

    test("sharing offline reads as unsent, never as a refusal", async () => {
      offline();
      const outcome = await nativeGrantDoor(BASE).create(REQUEST);
      expect(outcome).toStrictEqual({
        ok: false,
        message: GRANT_UNREACHABLE,
        reach: "unreachable",
      });
      // The two sentences are actually different words, not one string reused.
      expect(GRANT_UNREACHABLE).not.toBe(GRANT_FAILED);
    });

    test("revoking offline reads as unsent, never as a refusal", async () => {
      offline();
      await expect(
        nativeGrantDoor(BASE).revoke("grant-1")
      ).resolves.toStrictEqual({
        ok: false,
        message: REVOKE_UNREACHABLE,
        reach: "unreachable",
      });
      expect(REVOKE_UNREACHABLE).not.toBe(REVOKE_FAILED);
    });

    test("the registry is unknown offline and refused when the gateway says so", async () => {
      offline();
      await expect(nativeGrantDoor(BASE).subjects()).resolves.toStrictEqual({
        readable: false,
        offers: [],
        reach: "unreachable",
      });
      // Both are `readable: false`; only `reach` tells the surface which
      // sentence to print, and REGISTRY_UNREADABLE is not the offline one.
      expect(REGISTRY_UNREADABLE).not.toContain("out of reach");
    });

    test("a refused write keeps the gateway's own words, offline copy never borrowed", async () => {
      const message = "this vault will not share that";
      stubFetch(() => ({ status: 403, body: { error: "denied", message } }));
      const outcome = await nativeGrantDoor(BASE).create(REQUEST);
      expect(outcome).toStrictEqual({ ok: false, message, reach: "refused" });
    });
  });
});
