// The grant transport over the NATIVE seat's addressing: the law under test is
// shared with the browser seat, and what this file supplies is a phone's base
// URL and credential (#825, #883).
//
// A REFUSAL IS NOT AN OUTAGE — `fetch` rejecting means the request never left
// the phone and the gateway said nothing; a 4xx/5xx means it said something.
// Two facts, two sentences (docs/mobile-offline.md).
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  GRANT_FAILED,
  GRANT_UNREACHABLE,
  REGISTRY_UNREADABLE,
  REVOKE_FAILED,
  REVOKE_UNREACHABLE,
} from "@centraid/blueprints/apps/_shared/grant-copy";
import { isGrantUnreachable } from "@centraid/blueprints/apps/_shared/grant-door";
import { grantWireCalls } from "@centraid/blueprints/apps/_shared/grant-transport";

import {
  LINK_TICKET_UNAVAILABLE_HERE,
  nativeGrantDoor,
  nativeGrantHttp,
  nativeLinkTicketDoor,
} from "./grant-seat";

/** The shared wire law over THIS seat's addressed, credentialed requests. */
const nativeWire = (baseUrl: string) =>
  grantWireCalls(nativeGrantHttp(baseUrl));

const mintLinkTicket = vi.hoisted(() =>
  vi.fn<(baseUrl: string, vaultId: string) => Promise<unknown>>()
);

vi.mock(
  import("../../lib/gateway"),
  () => ({ apiHeaders: () => ({ Authorization: "Bearer test" }) }) as never
);
vi.mock(import("../../lib/replica/links-transport"), () => ({
  mintLinkTicket,
}));

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
      const wire = nativeWire(BASE);
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
        nativeWire(BASE).forAudience("circle", "circle-1")
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
        nativeWire(BASE).forParty("party-nobody")
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

    test("the revoke sentence and its locus promise are the route's, verbatim", async () => {
      // Two sentences, and neither is derivable from the other: `message` says
      // where the removal stands, `promise` says what this revoke can actually
      // keep for THIS principal kind (ruling V-locus).
      const message =
        "a vault holding a copy has been asked to remove it and has not yet confirmed";
      const promise =
        "their vault is asked to remove its copy; it is no longer shared either way";
      stubFetch(() => ({
        status: 200,
        body: { outcome: "revoked", message, promise },
      }));
      await expect(
        nativeGrantDoor(BASE).revoke("grant-1")
      ).resolves.toStrictEqual({ ok: true, message, promise });
    });

    test("a revoke with no promise makes none up", async () => {
      stubFetch(() => ({ status: 200, body: { outcome: "revoked" } }));
      const outcome = await nativeGrantDoor(BASE).revoke("grant-1");
      expect(outcome).toStrictEqual({ ok: true, message: REVOKE_FAILED });
    });

    test("an unreadable registry offers nothing rather than everything, and says which", async () => {
      stubFetch(() => ({ status: 500, body: { error: "boom" } }));
      await expect(nativeGrantDoor(BASE).subjects()).resolves.toStrictEqual({
        readable: false,
        offers: [],
        reach: "refused",
      });
    });

    test("a standing grant at another capability is REFUSED, in the vault's words", async () => {
      // #883 (ruling V-table): an answer is never edited in place, so the pack
      // refuses the second verb rather than reading the first one back. The
      // refusal names the fix, and nothing here may soften it into a success.
      const message =
        "this is already shared for view; withdraw that first — an answer changed in place could not be audited";
      stubFetch(() => ({
        status: 400,
        body: { error: "grant_refused", message },
      }));
      const outcome = await nativeGrantDoor(BASE).create({
        audienceKind: "party",
        audienceId: "party-priya",
        subjectType: "core.document",
        subjectId: "doc-1",
        capability: "edit",
      });
      expect(outcome).toStrictEqual({ ok: false, message, reach: "refused" });
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
            phrase: "on its way",
            reason: "no vault has been addressed for it yet",
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
      // The wire's phrase and reason ride through the door untouched.
      expect(outcome).toMatchObject({
        grant: {
          phrase: "on its way",
          reason: "no vault has been addressed for it yet",
        },
      });
    });

    test("a grant the vault parked is neither a landed grant nor a refusal", async () => {
      // 202. It is a 2xx, so only the body tells this from a share that stood.
      const message = "this needs your confirmation";
      stubFetch(() => ({
        status: 202,
        body: { error: "awaiting_confirmation", message },
      }));
      const outcome = await nativeGrantDoor(BASE).create({
        audienceKind: "party",
        audienceId: "party-priya",
        subjectType: "core.document",
        subjectId: "doc-1",
        capability: "view",
      });
      expect(outcome).toStrictEqual({
        ok: true,
        outcome: "awaiting_confirmation",
        message,
      });
    });
  });

  describe("changing a standing answer is withdraw-then-grant", () => {
    const REQUEST = {
      audienceKind: "party" as const,
      audienceId: "party-priya",
      subjectType: "core.document",
      subjectId: "doc-1",
      capability: "edit" as const,
    };

    test("the withdrawal goes first, and the grant follows it", async () => {
      const calls = stubFetch((call) =>
        call.url.endsWith("/revoke")
          ? { status: 200, body: { outcome: "revoked", message: "withdrawn" } }
          : { status: 201, body: { outcome: "created" } }
      );
      const outcome = await nativeGrantDoor(BASE).changeCapability(
        "grant-1",
        REQUEST
      );
      expect(outcome).toStrictEqual({ ok: true, outcome: "created" });
      expect(calls.map((call) => call.url)).toStrictEqual([
        `${BASE}/centraid/_vault/grants/grant-1/revoke`,
        `${BASE}/centraid/_vault/grants`,
      ]);
    });

    test("a withdrawal that did not land stops there — the old answer still stands", async () => {
      // Granting after a failed withdrawal would post the same answer twice and
      // be refused as a conflict, printing the wrong sentence at the member.
      const message = "the withdrawal could not be recorded";
      const calls = stubFetch(() => ({
        status: 500,
        body: { error: "boom", message },
      }));
      const outcome = await nativeGrantDoor(BASE).changeCapability(
        "grant-1",
        REQUEST
      );
      expect(outcome).toStrictEqual({ ok: false, message, reach: "refused" });
      expect(calls).toHaveLength(1);
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
      await expect(nativeWire(BASE).create(REQUEST)).rejects.toSatisfy(
        isGrantUnreachable
      );
      // A gateway that ANSWERED is never marked, however unhappy the answer.
      stubFetch(() => ({ status: 500, body: { error: "boom" } }));
      await expect(nativeWire(BASE).create(REQUEST)).rejects.not.toSatisfy(
        isGrantUnreachable
      );
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

describe("the native link-ticket door", () => {
  afterEach(() => {
    mintLinkTicket.mockReset();
  });

  test("without a vault it names the missing ceremony, and does not mint", async () => {
    await expect(
      nativeLinkTicketDoor(BASE, undefined)()
    ).resolves.toStrictEqual({
      ok: false,
      message: LINK_TICKET_UNAVAILABLE_HERE,
    });
    expect(mintLinkTicket).not.toHaveBeenCalled();
  });

  test("a minted ticket is the gateway's own string and expiry", async () => {
    mintLinkTicket.mockResolvedValue({
      ticket: "tkt-1",
      expiresAt: "2026-09-04T00:15:00.000Z",
    });
    await expect(
      nativeLinkTicketDoor(BASE, "vault-1")()
    ).resolves.toStrictEqual({
      ok: true,
      ticket: { ticket: "tkt-1", expiresAt: "2026-09-04T00:15:00.000Z" },
    });
    expect(mintLinkTicket).toHaveBeenCalledWith(BASE, "vault-1");
  });

  test("a payload the wire guard refuses is unavailability, not a throw", async () => {
    mintLinkTicket.mockResolvedValue({ ticket: "tkt-1" });
    await expect(
      nativeLinkTicketDoor(BASE, "vault-1")()
    ).resolves.toStrictEqual({
      ok: false,
      message: LINK_TICKET_UNAVAILABLE_HERE,
    });
  });

  test("the gateway's own refusal words ride through, verbatim", async () => {
    mintLinkTicket.mockRejectedValue(new Error("this vault will not mint"));
    await expect(
      nativeLinkTicketDoor(BASE, "vault-1")()
    ).resolves.toStrictEqual({
      ok: false,
      message: "this vault will not mint",
    });
  });
});
