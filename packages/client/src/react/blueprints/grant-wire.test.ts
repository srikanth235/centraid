import { afterEach, describe, expect, test, vi } from "vitest";

// The shell's grant-plane bridge (#825), the web seat's twin of
// `apps/mobile/src/kit/share/grants-transport.test.ts`.
//
// Four claims, and each is about honesty rather than plumbing:
//
//  1. Paths come from `@centraid/core/protocol`; a blueprint kit never sees a
//     URL, and no literal appears in this file either.
//  2. A refusal arrives as the ROUTE'S OWN message. `subject_not_offerable`
//     names the capabilities that subject does answer, and a transport error
//     in front of it would throw the useful half away.
//  3. An audience this vault has no record of is a real answer (`undefined`),
//     not a thrown failure — on the party read as much as the audience read.
//  4. The bridge hands the parsed body up untouched: the parsing law lives in
//     `grant-door`, shared with native, so the shell cannot pre-digest a
//     payload into a second reading of it.
import { ROUTES, vaultGrantRevokePath } from "@centraid/core/protocol";

const { calls } = vi.hoisted(() => ({
  calls: [] as { pathname: string; method: string; body?: string }[],
}));

/** What each stubbed exchange answers, set per test. */
let answer: (pathname: string) => { status: number; body: unknown } = () => ({
  status: 200,
  body: {},
});

// `gateway-client-core` touches `window.CentraidApi` at module load and is the
// one choke point the bridge routes through; stub it and record the exchange.
vi.mock(import("../../gateway-client-core.js") as Promise<unknown>, () => ({
  authHeaders: (token?: string) => (token ? { Authorization: token } : {}),
  doFetch: (baseUrl: string, pathname: string, init?: RequestInit) => {
    calls.push({
      pathname,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    const { status, body } = answer(pathname);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })
    );
  },
}));

const { grantBridge } = await import("./grant-wire.js");

const auth = (): Promise<{ baseUrl: string; token: string }> =>
  Promise.resolve({ baseUrl: "https://gw.test", token: "tok" });

describe("the shell's grant bridge", () => {
  afterEach(() => {
    calls.length = 0;
    answer = () => ({ status: 200, body: {} });
  });

  describe("addressing the grant plane", () => {
    test("each read asks the door the route serves", async () => {
      answer = () => ({ status: 200, body: { grants: [] } });
      const bridge = grantBridge(auth);
      await bridge.subjects();
      await bridge.forParty("party-priya");
      await bridge.forAudience("circle", "circle-1");
      await bridge.forSubject("core.document", "doc-1");
      await bridge.create({
        audienceKind: "party",
        audienceId: "party-priya",
        subjectType: "core.document",
        subjectId: "doc-1",
        capability: "view",
      });
      await bridge.revoke("grant 1");

      const grants = ROUTES.vaultGrants;
      expect(calls.map((call) => call.pathname)).toStrictEqual([
        ROUTES.vaultGrantSubjects,
        `${grants}?partyId=party-priya`,
        `${grants}?audienceKind=circle&audienceId=circle-1`,
        `${grants}?subjectType=core.document&subjectId=doc-1`,
        grants,
        vaultGrantRevokePath(encodeURIComponent("grant 1")),
      ]);
      expect(calls[4]?.method).toBe("POST");
      expect(JSON.parse(calls[4]?.body ?? "{}")).toMatchObject({
        capability: "view",
      });
    });

    test("the parsed body is handed up untouched", async () => {
      // The bridge must not pre-digest: `grant-door` is the one reading of a
      // payload, shared with the native seat.
      const grants = [{ grantId: "grant-1" }];
      answer = () => ({ status: 200, body: { channel: null, grants } });
      await expect(grantBridge(auth).forParty("party-priya")).resolves.toEqual({
        channel: null,
        grants,
      });
    });
  });

  describe("absent is never a read failure", () => {
    test("an audience the vault has no record of answers undefined", async () => {
      answer = () => ({ status: 404, body: { error: "audience_not_found" } });
      await expect(
        grantBridge(auth).forAudience("circle", "circle-1")
      ).resolves.toBeUndefined();
    });

    test("a person the vault has no record of answers undefined", async () => {
      // The primary read is `?partyId=`. Throwing here would make "we do not
      // know this person" arrive wearing "shares could not be read".
      answer = () => ({
        status: 404,
        body: {
          error: "audience_not_found",
          message: "this vault knows no such person",
        },
      });
      await expect(
        grantBridge(auth).forParty("party-nobody")
      ).resolves.toBeUndefined();
    });
  });

  describe("refusals keep the route's words", () => {
    test("a subject the vault cannot share is refused in its own terms", async () => {
      const message =
        "locker.item is not something this vault can share; nothing here can keep that grant true";
      answer = () => ({
        status: 400,
        body: { error: "subject_not_offerable", message },
      });
      await expect(
        grantBridge(auth).create({
          audienceKind: "party",
          audienceId: "party-priya",
          subjectType: "locker.item",
          subjectId: "secret-1",
          capability: "view",
        })
      ).rejects.toThrow(message);
    });

    test("a refusal with no message of its own names the operation and the error", async () => {
      answer = () => ({ status: 500, body: { error: "boom" } });
      await expect(grantBridge(auth).subjects()).rejects.toThrow(
        "read shareable subjects: boom"
      );
    });

    test("the revoke sentence is the route's, verbatim", async () => {
      const message =
        "no longer shared; a vault holding a copy has been asked to remove it and has not yet confirmed";
      answer = () => ({
        status: 200,
        body: { outcome: "revoked", removal: {}, message },
      });
      await expect(grantBridge(auth).revoke("grant-1")).resolves.toMatchObject({
        message,
      });
    });
  });
});
