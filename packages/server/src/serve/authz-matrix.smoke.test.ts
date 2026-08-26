import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, afterEach, beforeEach, expect, test } from "vitest";

/**
 * Authz matrix smoke (#496 G1): table-driven role/session × critical routes
 * against a real `serve()` daemon. Complements the denser per-route suites
 * with one compact cross-surface table the matrix can own.
 */
import { tempDir } from "@centraid/test-kit/temp-dir";

import type { GatewayPaths } from "../paths.js";
import { EnrollmentStore } from "./enrollment-store.js";
import { GatewayDatabase } from "./gateway-db.js";
import { PairingTicketStore } from "./pairing-store.js";
import { serve } from "./serve.js";
import type { GatewayServeHandle } from "./serve.js";

const ADMIN = "authz-smoke-admin-token";

let dataDir: string;
let handle: GatewayServeHandle;

function pathsUnder(dir: string): GatewayPaths {
  return { vaultDir: path.join(dir, "vault") };
}

describe("authz-matrix.smoke scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`authz-smoke-${crypto.randomUUID()}-`);
    // Pairing stores share the gateway's own database, so the owners surface
    // (an `admin` registry row) is mounted for the tier-enforcement cases.
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

  afterEach(async () => {
    await handle.close().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function hit(
    route: string,
    opts: { authorization?: string; method?: string } = {}
  ): Promise<number> {
    const res = await fetch(`${handle.url}${route}`, {
      method: opts.method ?? "GET",
      headers: opts.authorization ? { Authorization: opts.authorization } : {},
    });
    return res.status;
  }

  const CASES: Array<{
    name: string;
    route: string;
    authorization?: string;
    method?: string;
    /** Status family or exact code */
    expect: number | ((status: number) => boolean);
  }> = [
    {
      name: "no bearer → 401 on health (detail is host-auth gated)",
      route: "/centraid/_gateway/health",
      expect: 401,
    },
    {
      name: "admin bearer → 200 on health",
      route: "/centraid/_gateway/health",
      authorization: `Bearer ${ADMIN}`,
      expect: 200,
    },
    {
      name: "no bearer → 401 on vault plane",
      route: "/_centraid/vault/sql",
      method: "POST",
      expect: 401,
    },
    {
      name: "no bearer → 401 on apps list",
      route: "/centraid/_apps",
      expect: 401,
    },
    {
      name: "wrong bearer → 401",
      route: "/centraid/_apps",
      authorization: "Bearer totally-wrong-token",
      expect: 401,
    },
    {
      name: "admin bearer reaches apps (not 401/403)",
      route: "/centraid/_apps",
      authorization: `Bearer ${ADMIN}`,
      expect: (s) => s !== 401 && s !== 403 && s < 500,
    },
    {
      name: "admin bearer on vault plane is not 401 (auth accepted)",
      route: "/_centraid/vault/sql",
      method: "POST",
      authorization: `Bearer ${ADMIN}`,
      // Auth must succeed; body may still 4xx for missing SQL — never 401/403/5xx.
      expect: (s) => s !== 401 && s !== 403 && s < 500,
    },
    /*
     * `publicPaths` regression guard (issue #568 item L). Only the handshake
     * route is bearer-free; every capability-granting verb must 401 without a
     * credential. Re-adding one to `serve()`'s `publicPaths` fails CI here
     * rather than shipping an anonymous path to a capability.
     */
    {
      name: "no bearer → 401 on the vault erase ceremony",
      route: "/centraid/_vault/vaults:erase",
      method: "POST",
      expect: 401,
    },
    {
      name: "no bearer → 401 on the device pairing-ticket mint",
      route: "/centraid/_gateway/devices/ticket",
      method: "POST",
      expect: 401,
    },
    {
      name: "gateway info stays public (the pre-pairing handshake)",
      route: "/centraid/_gateway/info",
      expect: 200,
    },
  ];

  test.each(CASES)("authz smoke: $name", async (c) => {
    const status = await hit(c.route, {
      authorization: c.authorization,
      method: c.method,
    });
    const passed =
      typeof c.expect === "function" ? c.expect(status) : status === c.expect;
    expect(passed, `status ${status} for ${c.route}`).toBe(true);
  });

  /*
   * Admin tier at dispatch (#865 F2). The gateway-wide operator surfaces —
   * resource, diagnostics, storage, logs, owners — are registry `admin` rows,
   * and a proved DEVICE plane must get a 403 on each while the loopback
   * bearer (the owner's own path) still answers normally.
   */
  const ADMIN_GATEWAY_WIDE_ROUTES: Array<{
    route: string;
    method?: string;
  }> = [
    { route: "/centraid/_gateway/resource/pause", method: "DELETE" },
    { route: "/centraid/_gateway/diagnostics" },
    { route: "/centraid/_gateway/storage/status" },
    { route: "/centraid/_logs" },
    { route: "/centraid/_gateway/owners" },
  ];

  test.each(ADMIN_GATEWAY_WIDE_ROUTES)(
    "loopback bearer still answers $route",
    async ({ route, method }) => {
      const response = await hit(route, {
        authorization: `Bearer ${ADMIN}`,
        method,
      });
      expect(response).toBe(200);
    }
  );

  /**
   * A PWA proxy session resolves to the host device key
   * (`WebControlSessions.authorize` → `{plane:'device'}`), which is exactly
   * the proved-device identity the admin tier must refuse (#865 F2).
   */
  async function establishControlSession(): Promise<string> {
    const shellOrigin = "http://shell.local";
    const establish = await fetch(`${handle.url}/centraid/_web/control`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, origin: shellOrigin },
    });
    expect(establish.status).toBe(200);
    const cookie = (establish.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie).toMatch(/^__centraid_control=/u);
    return cookie;
  }

  test.each(ADMIN_GATEWAY_WIDE_ROUTES)(
    "a proved device identity gets 403 on $route",
    async ({ route }) => {
      const cookie = await establishControlSession();
      const proxied = await fetch(
        `${handle.url}/centraid/_web/control?path=${encodeURIComponent(route)}`,
        { headers: { cookie, origin: "http://shell.local" } }
      );
      expect(proxied.status).toBe(403);
      await expect(proxied.json()).resolves.toMatchObject({
        error: "admin_plane_forbidden",
      });
    }
  );

  test("the control-session proxy itself still works below the admin tier", async () => {
    // The refusal above must be the admin TIER, not the proxy lane breaking:
    // the same cookie reaches a device-tier route normally.
    const cookie = await establishControlSession();
    const health = await fetch(
      `${handle.url}/centraid/_web/control?path=${encodeURIComponent("/centraid/_gateway/health")}`,
      { headers: { cookie, origin: "http://shell.local" } }
    );
    expect(health.status).toBe(200);
  });

  /*
   * Issue #568 item C. `/centraid/_gateway/info` is public so a client can read
   * the version/schema handshake before it can pair — but `endpointTicket` is
   * this gateway's iroh DIAL ticket. A browser fetch to `http://127.0.0.1:<port>` from any
   * page the owner visits IS a loopback socket, a plain GET needs no preflight,
   * and `decideCors` answers a foreign origin `*` — so loopback cannot be the
   * gate. Only a presented credential may see it.
   */
  test("gateway info withholds the endpoint ticket from an unauthenticated caller", async () => {
    const anonymous = await fetch(`${handle.url}/centraid/_gateway/info`);
    expect(anonymous.status).toBe(200);
    const anonymousBody = (await anonymous.json()) as Record<string, unknown>;
    // The handshake still answers: version + protocol are what a client needs
    // before it can pair at all.
    expect(anonymousBody.protocolVersion).toStrictEqual(expect.any(Number));
    expect(anonymousBody).not.toHaveProperty("endpointTicket");

    const authenticated = await fetch(`${handle.url}/centraid/_gateway/info`, {
      headers: { Authorization: `Bearer ${ADMIN}` },
    });
    expect(authenticated.status).toBe(200);
    const authenticatedBody = (await authenticated.json()) as Record<
      string,
      unknown
    >;
    expect(authenticatedBody.protocolVersion).toStrictEqual(
      anonymousBody.protocolVersion
    );

    // A WRONG bearer is not a credential: it must be treated as anonymous on a
    // public path, never as "close enough because it is loopback".
    const wrong = await fetch(`${handle.url}/centraid/_gateway/info`, {
      headers: { Authorization: "Bearer not-the-admin-token" },
    });
    expect(wrong.status).toBe(200);
    await expect(wrong.json()).resolves.not.toHaveProperty("endpointTicket");
  });
});
