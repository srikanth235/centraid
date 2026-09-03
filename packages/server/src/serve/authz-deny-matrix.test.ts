import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { ROUTES } from "@centraid/core/protocol";
import type { RouteName } from "@centraid/core/protocol";
import { tempDir } from "@centraid/test-kit/temp-dir";

import type { GatewayPaths } from "../paths.js";
import { EnrollmentStore } from "./enrollment-store.js";
import { GatewayDatabase } from "./gateway-db.js";
import { PairingTicketStore } from "./pairing-store.js";
import { serve } from "./serve.js";
import type { GatewayServeHandle } from "./serve.js";

const ADMIN = "authz-deny-matrix-admin-token";
const SHELL_ORIGIN = "http://shell.local";
const PROBE_TIMEOUT_MS = 5_000;

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
    await response.body?.cancel().catch(() => undefined);
    return response.status;
  } catch {
    return 599;
  }
}

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

  test("the route table is non-empty and every entry is probed", () => {
    expect(routeEntries.length).toBeGreaterThan(20);
    expect(routeEntries.every(([, route]) => route.startsWith("/"))).toBe(true);
  });

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

  test("every DELIBERATELY_PUBLIC entry names a real route and states why", () => {
    for (const [name, reason] of Object.entries(DELIBERATELY_PUBLIC)) {
      expect(ROUTES).toHaveProperty(name);
      expect(reason.length).toBeGreaterThan(60);
    }
  });
});
