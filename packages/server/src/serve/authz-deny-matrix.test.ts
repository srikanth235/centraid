import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { PEER_REPLICA_PATHS, ROUTES } from "@centraid/core/protocol";
import type { RouteName } from "@centraid/core/protocol";
import { tempDir } from "@centraid/test-kit/temp-dir";

import type { GatewayPaths } from "../paths.js";
import { EnrollmentStore } from "./enrollment-store.js";
import { GatewayDatabase } from "./gateway-db.js";
import { PairingTicketStore } from "./pairing-store.js";
import { link, makeSide, transportTo } from "./peer-give.test-fixtures.js";
import { serve } from "./serve.js";
import type { GatewayServeHandle } from "./serve.js";

/**
 * THE DENY MATRIX, GENERATED FROM THE ROUTE TABLE (#892 Phase 2).
 *
 * `authz-matrix.smoke.test.ts` next door is a hand-written CASES list, and it is
 * good — but a hand-written list has exactly one failure mode, and it is the
 * only one that matters here: a route added tomorrow is not in it. The #890
 * audit's exhibit was three `transfer-policy` bypasses, and the shape they share
 * is that nothing enumerated the surface, so nothing could notice a hole in it.
 *
 * This suite enumerates `ROUTES` itself. Every entry is probed with every
 * principal below and must DENY — where deny means "does not answer 2xx",
 * because a 401, a 403 and a 404 are all refusals and which one a route picks is
 * its own business. A route that answers is a failure UNLESS it is listed in
 * `DELIBERATELY_PUBLIC` with a reason, so the default for a new route is closed
 * and opening one is a reviewable line in a diff rather than an omission.
 *
 * THE PRINCIPALS, and what each stands in for:
 *
 *   anonymous        no credential at all.
 *   forged bearer    a syntactically fine bearer the gateway does not honour.
 *                    This is also what a REVOKED PAIR and an EXPIRED GRANT look
 *                    like on the wire — the credential is presented and is no
 *                    longer good — which is why they are one principal here
 *                    rather than three fixtures of the same shape.
 *   proved device    a real control-session cookie (`WebControlSessions`
 *                    resolves it to `{plane:'device'}`). Not anonymous, not the
 *                    owner: the WRONG-AUTHORITY case, which is the one a
 *                    bearer-only matrix cannot see at all.
 *
 * A proved device is a legitimate principal for most of the product, so it is
 * asserted only against the gateway-wide admin surfaces, where #865 F2 already
 * decided it must be refused.
 */

const ADMIN = "authz-deny-matrix-admin-token";
const SHELL_ORIGIN = "http://shell.local";
/** No stream may hold a probe open; every route must answer or be refused. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Routes that answer without a credential, each with the reason it must.
 *
 * This is the ONLY way a route escapes the matrix, and the reason is required
 * reading rather than decoration: "the pre-pairing handshake" is a decision
 * (#568 item C), and a future entry has to make an equally specific one.
 */
const DELIBERATELY_PUBLIC: Partial<Record<RouteName, string>> = {
  gatewayInfo:
    "the pre-pairing handshake: a client must read version + protocolVersion " +
    "BEFORE it can hold a credential. #568 item C removed the endpointTicket " +
    "from the anonymous body precisely so that publicness costs nothing, and " +
    "authz-matrix.smoke.test.ts pins that redaction.",
};

function pathsUnder(dir: string): GatewayPaths {
  return { vaultDir: path.join(dir, "vault") };
}

let dataDir: string;
let handle: GatewayServeHandle;

async function probe(
  route: string,
  init: { method: string; headers?: Record<string, string> }
): Promise<number> {
  try {
    const response = await fetch(`${handle.url}${route}`, {
      method: init.method,
      headers: init.headers ?? {},
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // Drain: an SSE route answers 200 and then streams forever, and an
    // undrained body keeps the socket (and the suite) alive.
    await response.body?.cancel().catch(() => undefined);
    return response.status;
  } catch {
    // A refused/aborted connection is a refusal, which is what this suite is
    // asking about. Report it as one rather than failing the probe itself.
    return 599;
  }
}

/** The verbs a capability is plausibly reached through. */
const METHODS = ["GET", "POST"] as const;

const routeEntries = Object.entries(ROUTES) as [RouteName, string][];

describe("authz deny matrix (generated from ROUTES)", () => {
  beforeAll(async () => {
    dataDir = await tempDir(`authz-deny-${crypto.randomUUID()}-`);
    const database = GatewayDatabase.open(dataDir);
    handle = await serve({
      paths: pathsUnder(dataDir),
      gatewayDatabase: database,
      devicePairing: {
        enrollments: EnrollmentStore.open(database),
        tickets: PairingTicketStore.open(database),
      },
      token: ADMIN,
    });
  });

  afterAll(async () => {
    await handle?.close().catch(() => undefined);
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  });

  // The generator having something to generate FROM is itself an assertion: an
  // empty ROUTES import would make every `test.each` below vanish and the file
  // report green (#556's shape, in miniature).
  test("the route table is non-empty and every entry is probed", () => {
    expect(routeEntries.length).toBeGreaterThan(20);
    expect(routeEntries.every(([, route]) => route.startsWith("/"))).toBe(true);
  });

  /**
   * Probe one route with one principal on every verb and reduce the answer to
   * the two facts the assertions need.
   *
   * The reduction happens HERE, before any `expect`, on purpose: the
   * deliberately-public routes make the verdict conditional on the route, and a
   * conditional assertion inside the loop would mean a run that asserted nothing
   * could still report green.
   */
  async function probeAllVerbs(
    route: string,
    headers?: Record<string, string>
  ): Promise<{
    statuses: Record<string, number>;
    denied: string[];
    answered: string[];
  }> {
    const results = await Promise.all(
      METHODS.map(
        async (method) =>
          [method, await probe(route, { method, headers })] as const
      )
    );
    return {
      statuses: Object.fromEntries(results),
      denied: results
        .filter(([, status]) => status >= 400)
        .map(([method]) => method),
      answered: results
        .filter(([, status]) => status < 400)
        .map(([method]) => method),
    };
  }

  test.each(routeEntries)(
    "%s denies an anonymous caller on every verb",
    async (name, route) => {
      const reason = DELIBERATELY_PUBLIC[name];
      const { statuses, denied, answered } = await probeAllVerbs(route);
      // A deliberately-public route must still ANSWER its GET — a 401 there
      // would mean the handshake broke, which is a different bug worth catching.
      const expectedDenied = reason
        ? METHODS.filter((method) => method !== "GET")
        : [...METHODS];
      expect(
        denied.toSorted(),
        `${name} answered ${JSON.stringify(statuses)} to an anonymous caller (answered: ${answered.join(", ") || "none"}). ` +
          (reason
            ? `It is DELIBERATELY_PUBLIC on GET (${reason}); every other verb must still refuse.`
            : `If any of that is intended, add it to DELIBERATELY_PUBLIC with the reason; otherwise it is a capability reachable with no credential.`)
      ).toStrictEqual(expectedDenied.toSorted());
    }
  );

  test.each(routeEntries)(
    "%s denies a forged bearer on every verb",
    async (name, route) => {
      const reason = DELIBERATELY_PUBLIC[name];
      // Shaped like the real thing, and wrong — the wire signature of a revoked
      // pair and of an expired grant alike.
      const { statuses, denied } = await probeAllVerbs(route, {
        Authorization: "Bearer not-the-admin-token",
      });
      const expectedDenied = reason
        ? METHODS.filter((method) => method !== "GET")
        : [...METHODS];
      expect(
        denied.toSorted(),
        `${name} answered ${JSON.stringify(statuses)} to a bearer this gateway does not honour — a revoked or expired credential must not be "close enough".`
      ).toStrictEqual(expectedDenied.toSorted());
    }
  );

  /**
   * The wrong-authority case. A control session is a REAL principal — it is how
   * the PWA reaches the gateway — so this is not "an attacker"; it is the member
   * on a surface that must not hold gateway-wide operator powers (#865 F2).
   */
  describe("a proved device identity", () => {
    const ADMIN_TIER = [
      "/centraid/_gateway/diagnostics",
      "/centraid/_gateway/storage/status",
      "/centraid/_gateway/owners",
      "/centraid/_logs",
    ];

    async function controlCookie(): Promise<string> {
      const established = await fetch(`${handle.url}${ROUTES.webControl}`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN}`, origin: SHELL_ORIGIN },
      });
      expect(established.status).toBe(200);
      return (established.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    }

    test.each(ADMIN_TIER)("is refused %s", async (route) => {
      const cookie = await controlCookie();
      const response = await fetch(
        `${handle.url}${ROUTES.webControl}?path=${encodeURIComponent(route)}`,
        {
          headers: { cookie, origin: SHELL_ORIGIN },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        }
      );
      expect(response.status).toBe(403);
      await response.body?.cancel().catch(() => undefined);
    });
  });

  /**
   * THE LINK-AUTHENTICATED CALLER (#929). A subscription is admitted by a peer
   * proof plus a live link pair, and that is a REAL principal now — the peer
   * plane serves the grant-keyed replica shape over it. It must reach the
   * subscription doors and NOTHING ELSE: a link is not a device, so no
   * device-tier route may answer it, and the vault-plane replica surface in
   * particular must stay unreachable however the target is spelled.
   */
  describe("a link-authenticated peer", () => {
    test("reaches no device-tier route, and the subscription paths are the only peer-plane replica doors", async () => {
      const origin = makeSide("deny-origin");
      const audience = makeSide("deny-audience");
      await link(origin, audience);
      const dial = transportTo(origin, audience.endpointId);
      const probes = Object.values(ROUTES).flatMap((route) =>
        METHODS.map(async (method) => {
          const response = await dial({
            endpointTicket: "ticket",
            method,
            target: route,
          });
          // `0` is the handler declining the target outright — the peer plane
          // never saw it, which is the confinement this asserts. Anything in
          // the 2xx/3xx band is an ANSWER and a hole.
          return response.status >= 200 && response.status < 400
            ? `${method} ${route}`
            : undefined;
        })
      );
      const answered = (await Promise.all(probes)).filter(
        (entry): entry is string => entry !== undefined
      );
      expect(answered).toStrictEqual([]);
      // The confinement is the peer-plane prefix itself: a device-tier target
      // dressed as a peer target is still not one of these four.
      expect(
        Object.values(ROUTES).some((route) =>
          PEER_REPLICA_PATHS.includes(route)
        )
      ).toBe(false);
      origin.vault.close();
      audience.vault.close();
    });
  });

  test("every DELIBERATELY_PUBLIC entry names a real route and states why", () => {
    // An allowlist whose entries can rot into names that no longer exist is a
    // list that stops meaning anything — and the stale entry would keep looking
    // like a reviewed decision.
    for (const [name, reason] of Object.entries(DELIBERATELY_PUBLIC)) {
      expect(ROUTES).toHaveProperty(name);
      expect(reason.length).toBeGreaterThan(60);
    }
  });
});
