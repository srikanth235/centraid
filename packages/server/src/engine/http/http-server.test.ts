import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { Runtime } from "../runtime.ts";
import { startRuntimeHttpServer, AUTHED_DEVICE_HEADER } from "./http-server.ts";
import type { RuntimeHttpServerHandle } from "./http-server.ts";

function rawRequest(
  baseUrl: string,
  path: string,
  opts: {
    method?: string;
    host?: string;
    headers?: Record<string, string>;
  } = {}
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  const u = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: opts.method ?? "GET",
        setHost: opts.host === undefined,
        headers: {
          ...opts.headers,
          ...(opts.host === undefined ? {} : { host: opts.host }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

let workspace: string;
let server: RuntimeHttpServerHandle;

describe("http-server", () => {
  beforeEach(async () => {
    workspace = await tempDir(`runtime-http-${crypto.randomUUID()}-`);
    const runtime = new Runtime({ appsDir: workspace });
    server = await startRuntimeHttpServer({ runtime });
    await runtime.bootstrap();
  });

  afterEach(async () => {
    await server.close().catch(() => undefined);
    await fs.rm(workspace, { recursive: true, force: true });
  });

  test("binds to loopback and rejects requests without the bearer token", async () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(server.token).toHaveLength(64);

    const res = await fetch(`${server.url}/centraid/_apps`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  test("serves the registry list when the bearer token matches", async () => {
    const res = await fetch(`${server.url}/centraid/_apps`, {
      headers: { Authorization: `Bearer ${server.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toStrictEqual([]);
  });

  test("returns 404 for unknown /centraid paths (with valid bearer)", async () => {
    const res = await fetch(`${server.url}/centraid/nope/whatever`, {
      headers: { Authorization: `Bearer ${server.token}` },
    });
    expect(res.status).toBe(404);
  });

  test("answers a CORS preflight (OPTIONS) with 204 and no auth required", async () => {
    const res = await fetch(`${server.url}/centraid/_apps`, {
      method: "OPTIONS",
      headers: {
        Origin: "null",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "authorization, content-type, x-content-sha256",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods") ?? "").toMatch(
      /POST/u
    );
    expect(res.headers.get("access-control-allow-headers") ?? "").toMatch(
      /authorization/iu
    );
    expect(res.headers.get("access-control-allow-headers") ?? "").toMatch(
      /(?:^|,\s*)x-content-sha256(?:\s*,|$)/iu
    );
  });

  test("sets CORS headers on the 401 so the renderer can read the rejection", async () => {
    const res = await fetch(`${server.url}/centraid/_apps`);
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("sets CORS headers on a successful authed response", async () => {
    const res = await fetch(`${server.url}/centraid/_apps`, {
      headers: { Authorization: `Bearer ${server.token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("every transport-boundary response carries nosniff (#846 P10 / #844)", async () => {
    const unauthorized = await fetch(`${server.url}/centraid/_apps`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("x-content-type-options")).toBe("nosniff");

    const badHost = await rawRequest(server.url, "/centraid/_apps", {
      host: "evil.example:9999",
      headers: { Authorization: `Bearer ${server.token}` },
    });
    expect(badHost.status).toBe(400);
    expect(badHost.headers["x-content-type-options"]).toBe("nosniff");

    const runtime = new Runtime({ appsDir: workspace });
    const guarded = await startRuntimeHttpServer({
      runtime,
      extraHandlers: [
        (req) => {
          if (req.url === "/boom") throw new Error("boom");
          return Promise.resolve(false);
        },
      ],
    });
    try {
      const failed = await fetch(`${guarded.url}/boom`, {
        headers: { Authorization: `Bearer ${guarded.token}` },
      });
      expect(failed.status).toBe(500);
      expect(failed.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      await guarded.close();
    }
  });

  test("refuses a non-allowlisted Host header before handlers (#504)", async () => {
    const bad = await rawRequest(server.url, "/centraid/_apps", {
      host: "evil.example:9999",
      headers: { Authorization: `Bearer ${server.token}` },
    });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body)).toMatchObject({ error: "invalid_host" });

    const port = new URL(server.url).port;
    const ok = await rawRequest(server.url, "/centraid/_apps", {
      host: `127.0.0.1:${port}`,
      headers: { Authorization: `Bearer ${server.token}` },
    });
    expect(ok.status).toBe(200);
  });

  test("does not reflect foreign Origin with credentials for cookie-only requests (#504)", async () => {
    const runtime = new Runtime({ appsDir: workspace });
    const shell = "http://127.0.0.1:4173";
    const hardened = await startRuntimeHttpServer({
      runtime,
      credentialedCorsOrigins: [shell],
      authorizeRequest: (req) => {
        if ((req.headers.cookie ?? "").includes("session=ok"))
          return { plane: "admin" };
        return undefined;
      },
    });
    try {
      const foreign = await fetch(`${hardened.url}/centraid/_apps`, {
        headers: {
          Origin: "http://127.0.0.1:9999",
          Cookie: "session=ok",
        },
      });
      expect(foreign.headers.get("access-control-allow-origin")).toBe("*");
      expect(
        foreign.headers.get("access-control-allow-credentials")
      ).toBeNull();

      const bound = await fetch(`${hardened.url}/centraid/_apps`, {
        headers: {
          Origin: shell,
          Cookie: "session=ok",
        },
      });
      expect(bound.headers.get("access-control-allow-origin")).toBe(shell);
      expect(bound.headers.get("access-control-allow-credentials")).toBe(
        "true"
      );

      const bearer = await fetch(`${hardened.url}/centraid/_apps`, {
        headers: {
          Origin: "http://127.0.0.1:9999",
          Authorization: `Bearer ${hardened.token}`,
        },
      });
      expect(bearer.status).toBe(200);
      expect(bearer.headers.get("access-control-allow-origin")).toBe(
        "http://127.0.0.1:9999"
      );
      expect(bearer.headers.get("access-control-allow-credentials")).toBe(
        "true"
      );
    } finally {
      await hardened.close();
    }
  });

  test("contains rejected handlers at the HTTP boundary before and after headers", async () => {
    const runtime = new Runtime({ appsDir: workspace });
    const guarded = await startRuntimeHttpServer({
      runtime,
      extraHandlers: [
        async (req, res) => {
          if (req.url === "/reject-before") throw new Error("before headers");
          if (req.url === "/reject-after") {
            res.writeHead(200, { "content-type": "application/octet-stream" });
            res.write("x");
            throw new Error("after headers");
          }
          return false;
        },
      ],
    });
    try {
      const before = await fetch(`${guarded.url}/reject-before`, {
        headers: { Authorization: `Bearer ${guarded.token}` },
      });
      expect(before.status).toBe(500);
      await expect(before.json()).resolves.toStrictEqual({
        error: "internal_server_error",
      });

      await expect(
        fetch(`${guarded.url}/reject-after`, {
          headers: { Authorization: `Bearer ${guarded.token}` },
        }).then((response) => response.arrayBuffer())
      ).rejects.toThrow(/terminated/u);

      const healthy = await fetch(`${guarded.url}/centraid/_apps`, {
        headers: { Authorization: `Bearer ${guarded.token}` },
      });
      expect(healthy.status).toBe(200);
    } finally {
      await guarded.close();
    }
  });

  test("publicPaths serve without the bearer; everything else still 401s (issue #304)", async () => {
    const runtime = new Runtime({ appsDir: workspace });
    const publicServer = await startRuntimeHttpServer({
      runtime,
      publicPaths: ["/centraid/_vault/oauth/callback"],
      extraHandlers: [
        async (req, res) => {
          if (!(req.url ?? "").startsWith("/centraid/_vault/oauth/callback"))
            return false;
          res.writeHead(200, { "content-type": "text/html" });
          res.end("<h1>ceremony</h1>");
          return true;
        },
      ],
    });
    try {
      const open = await fetch(
        `${publicServer.url}/centraid/_vault/oauth/callback?state=x&code=y`
      );
      expect(open.status).toBe(200);
      await expect(open.text()).resolves.toContain("ceremony");
      const sibling = await fetch(
        `${publicServer.url}/centraid/_vault/oauth/callback/deeper`
      );
      expect(sibling.status).toBe(401);
      const other = await fetch(`${publicServer.url}/centraid/_apps`);
      expect(other.status).toBe(401);
    } finally {
      await publicServer.close();
    }
  });

  test("authorizeBearer (issue #376): bearer-only access, device access, and refusal", async () => {
    const runtime = new Runtime({ appsDir: workspace });
    const pluggableServer = await startRuntimeHttpServer({
      runtime,
      extraHandlers: [
        async (req, res) => {
          if ((req.url ?? "") !== "/centraid/_echo-device") return false;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              deviceHeader: req.headers[AUTHED_DEVICE_HEADER] ?? null,
            })
          );
          return true;
        },
      ],
      authorizeBearer: (bearer) => {
        if (bearer === "admin-secret") return { plane: "admin" };
        if (bearer === "device-secret")
          return { plane: "device", deviceKey: "dev-abc" };
        return undefined;
      },
    });
    try {
      const bad = await fetch(`${pluggableServer.url}/centraid/_apps`, {
        headers: { Authorization: "Bearer nope" },
      });
      expect(bad.status).toBe(401);

      const admin = await fetch(
        `${pluggableServer.url}/centraid/_echo-device`,
        {
          headers: { Authorization: "Bearer admin-secret" },
        }
      );
      expect(admin.status).toBe(200);
      await expect(admin.json()).resolves.toStrictEqual({ deviceHeader: null });

      const device = await fetch(
        `${pluggableServer.url}/centraid/_echo-device`,
        {
          headers: { Authorization: "Bearer device-secret" },
        }
      );
      expect(device.status).toBe(200);
      await expect(device.json()).resolves.toStrictEqual({
        deviceHeader: "dev-abc",
      });

      const forged = await fetch(
        `${pluggableServer.url}/centraid/_echo-device`,
        {
          headers: {
            Authorization: "Bearer admin-secret",
            [AUTHED_DEVICE_HEADER]: "forged-key",
          },
        }
      );
      expect(forged.status).toBe(200);
      await expect(forged.json()).resolves.toStrictEqual({
        deviceHeader: null,
      });
    } finally {
      await pluggableServer.close();
    }
  });

  test("publicPathPrefixes serve without the bearer for the whole subtree (issue #96)", async () => {
    const runtime = new Runtime({ appsDir: workspace });
    const publicServer = await startRuntimeHttpServer({
      runtime,
      publicPathPrefixes: ["/_centraid-hook"],
      extraHandlers: [
        async (req, res) => {
          if (!(req.url ?? "").startsWith("/_centraid-hook")) return false;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, url: req.url }));
          return true;
        },
      ],
    });
    try {
      const open = await fetch(`${publicServer.url}/_centraid-hook/abc123`, {
        method: "POST",
      });
      expect(open.status).toBe(200);
      await expect(open.json()).resolves.toStrictEqual({
        ok: true,
        url: "/_centraid-hook/abc123",
      });
      const other = await fetch(`${publicServer.url}/centraid/_apps`);
      expect(other.status).toBe(401);
    } finally {
      await publicServer.close();
    }
  });
});
