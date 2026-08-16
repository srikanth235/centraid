import crypto from "node:crypto";
// governance: allow-repo-hygiene file-size-limit (#608) cohesive browser-session contract shares one production gateway and app fixture
import { promises as fs } from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";

import { describe, afterEach, beforeEach, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";

import type { GatewayPaths } from "../paths.js";
import type { WorktreeStore } from "../worktree-store/index.js";
import { serve } from "./serve.js";
import type { GatewayServeHandle } from "./serve.js";
import { WebControlSessions } from "./web-control-sessions.js";
import {
  WebControlSessionStore,
  hashControlToken,
} from "./web-session-store.js";

let dataDir: string;
let handle: GatewayServeHandle;

function pathsUnder(dir: string): GatewayPaths {
  return { vaultDir: path.join(dir, "vault") };
}

async function seedApp(store: WorktreeStore, appId: string): Promise<void> {
  const sessionId = `seed-${appId}`;
  const session = await store.openSession(sessionId);
  const appDir = path.join(session.worktreePath, "apps", appId);
  await fs.mkdir(path.join(appDir, "queries"), { recursive: true });
  await fs.writeFile(
    path.join(appDir, "app.json"),
    JSON.stringify({
      manifestVersion: 1,
      id: appId,
      name: appId,
      version: "0.1.0",
      tables: [],
      actions: [],
      queries: [
        {
          name: "ping",
          description: "ping",
          input: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    })
  );
  await fs.writeFile(
    path.join(appDir, "index.html"),
    `<!doctype html><html><head></head><body>${appId}</body></html>`
  );
  await fs.writeFile(
    path.join(appDir, "queries", "ping.js"),
    `export default async () => ({ app: '${appId}' });\n`
  );
  await store.publish({ sessionId, appId, message: "seed" });
  await store.closeSession(sessionId);
}

describe("web-control-sessions.contract scenarios", () => {
  beforeEach(async () => {
    dataDir = await tempDir(`web-session-${crypto.randomUUID()}-`);
    handle = await serve({ paths: pathsUnder(dataDir) });
    const store = await handle.appsStore();
    await seedApp(store, "alpha");
    await seedApp(store, "beta");
    await handle.syncApps();
  }, 30_000);

  afterEach(async () => {
    await handle.close().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("pairing a second control session does not invalidate the first", async () => {
    async function establish(): Promise<string> {
      const res = await fetch(`${handle.url}/centraid/_web/control`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.token}`,
          Origin: "http://127.0.0.1:4173",
        },
      });
      expect(res.status).toBe(200);
      return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    }

    const first = await establish();
    const second = await establish();
    expect(first).not.toBe(second);

    // Both control cookies remain live after the second pairing.
    await forEachSequentially([first, second], async (cookie) => {
      const proxied = await fetch(
        `${handle.url}/centraid/_web/control?path=${encodeURIComponent("/centraid/_apps")}`,
        { headers: { Cookie: cookie, Origin: "http://127.0.0.1:4173" } }
      );
      expect(proxied.status).toBe(200);
    });
  });

  test("control session keeps the bearer out of browser storage and enforces its shell Origin", async () => {
    const established = await fetch(`${handle.url}/centraid/_web/control`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.token}`,
        Origin: "http://127.0.0.1:4173",
      },
    });
    expect(established.status).toBe(200);
    const setCookie = established.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Path=/centraid/_web/control");
    const cookie = setCookie.split(";")[0] ?? "";

    const proxied = await fetch(
      `${handle.url}/centraid/_web/control?path=${encodeURIComponent("/centraid/_apps")}`,
      { headers: { Cookie: cookie, Origin: "http://127.0.0.1:4173" } }
    );
    expect(proxied.status).toBe(200);
    expect((await proxied.json()) as Array<{ id: string }>).toStrictEqual(
      expect.arrayContaining([expect.objectContaining({ id: "alpha" })])
    );

    const wrongOrigin = await fetch(
      `${handle.url}/centraid/_web/control?path=${encodeURIComponent("/centraid/_apps")}`,
      { headers: { Cookie: cookie, Origin: handle.url } }
    );
    expect(wrongOrigin.status).toBe(401);

    const noOrigin = await fetch(
      `${handle.url}/centraid/_web/control?path=${encodeURIComponent("/centraid/_apps")}`,
      { headers: { Cookie: cookie } }
    );
    expect(noOrigin.status).toBe(401);
  });

  const SHELL = "http://127.0.0.1:4173";

  async function establishControl(): Promise<string> {
    const res = await fetch(`${handle.url}/centraid/_web/control`, {
      method: "POST",
      headers: { Authorization: `Bearer ${handle.token}`, Origin: SHELL },
    });
    expect(res.status).toBe(200);
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }

  function proxyControl(cookie: string): Promise<Response> {
    return fetch(
      `${handle.url}/centraid/_web/control?path=${encodeURIComponent("/centraid/_apps")}`,
      {
        headers: { Cookie: cookie, Origin: SHELL },
      }
    );
  }

  test("a closed same-origin PWA can fetch only private wake surfaces", async () => {
    const cookie = await establishControl();
    const wakeHeaders = {
      Cookie: cookie,
      "sec-fetch-site": "same-origin",
      "x-centraid-service-worker": "notifications-wake",
    };
    const notifications = await fetch(
      `${handle.url}/centraid/_web/control?path=${encodeURIComponent("/centraid/_vault/notifications")}`,
      { headers: wakeHeaders }
    );
    expect(notifications.status).toBe(200);
    await expect(notifications.json()).resolves.toMatchObject({
      decisions: expect.any(Object),
      notices: expect.any(Array),
    });

    const missingPurpose = await fetch(
      `${handle.url}/centraid/_web/control?path=${encodeURIComponent("/centraid/_vault/notifications")}`,
      {
        headers: {
          Cookie: cookie,
          "sec-fetch-site": "same-origin",
        },
      }
    );
    expect(missingPurpose.status).toBe(401);

    const widerControlSurface = await fetch(
      `${handle.url}/centraid/_web/control?path=${encodeURIComponent("/centraid/_apps")}`,
      { headers: wakeHeaders }
    );
    expect(widerControlSurface.status).toBe(401);
  });

  test("a persisted control session still authorizes after a gateway restart", async () => {
    const controlsFile = path.join(dataDir, "web-sessions.json");
    // Re-serve the same dataDir WITH persistence wired.
    await handle.close();
    handle = await serve({
      paths: pathsUnder(dataDir),
      webSessions: { controlsFile },
    });
    await handle.syncApps();
    const cookie = await establishControl();
    expect((await proxyControl(cookie)).status).toBe(200);

    // "Restart": a brand-new gateway process on the same file — the browser
    // kept only its HttpOnly cookie, yet it must still authorize.
    await handle.close();
    handle = await serve({
      paths: pathsUnder(dataDir),
      webSessions: { controlsFile },
    });
    await handle.syncApps();
    expect((await proxyControl(cookie)).status).toBe(200);
  });

  test("logout drops the control session server-side and expires the cookie", async () => {
    const cookie = await establishControl();
    expect((await proxyControl(cookie)).status).toBe(200);

    // An unauthenticated DELETE is rejected like any other.
    const noCookie = await fetch(`${handle.url}/centraid/_web/control`, {
      method: "DELETE",
      headers: { Origin: SHELL },
    });
    expect(noCookie.status).toBe(401);

    // A DELETE with the cookie + matching Origin logs out: 200 + expiring cookie.
    const out = await fetch(`${handle.url}/centraid/_web/control`, {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: SHELL },
    });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie") ?? "").toContain("Max-Age=0");

    // The cookie no longer authorizes.
    expect((await proxyControl(cookie)).status).toBe(401);
  });

  test("a proxied DELETE (with ?path) is forwarded, not treated as a logout", async () => {
    const cookie = await establishControl();
    expect((await proxyControl(cookie)).status).toBe(200);

    // A DELETE carrying a proxied `?path=` is an ordinary API call (e.g. the
    // shell revoking a device), NOT a control-session logout. It must reach the
    // inner route — and, critically, must NOT expire the control cookie.
    const del = await fetch(
      `${handle.url}/centraid/_web/control?path=${encodeURIComponent("/centraid/_apps")}`,
      { method: "DELETE", headers: { Cookie: cookie, Origin: SHELL } }
    );
    // Whatever the inner route answers (here _apps has no DELETE), it is not the
    // logout's cookie-expiring response.
    expect(del.headers.get("set-cookie") ?? "").not.toContain("Max-Age=0");

    // The session survived: the cookie still authorizes.
    expect((await proxyControl(cookie)).status).toBe(200);
  });

  test("a control session without a proved device identity fails closed", async () => {
    const controlsFile = path.join(dataDir, "web-sessions.json");
    await handle.close();
    // There is no shared-bearer admin wildcard: a session without a device key
    // cannot survive the enrollment check.
    handle = await serve({
      paths: pathsUnder(dataDir),
      webSessions: { controlsFile, isDeviceValid: () => false },
    });
    await handle.syncApps();
    const cookie = await establishControl();
    expect((await proxyControl(cookie)).status).toBe(401);
  });

  // ── Revocation propagation for device-bound sessions ──────────────────────
  // These drive `WebControlSessions` directly: the e2e serve() rig has no
  // device plane, so a bearer-established session never carries a deviceKey.
  // Seeding a deviceKey-bound session in isolation is the only way to exercise
  // the `isDeviceValid` gate the daemon wires in cli.ts.

  function req(init: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): IncomingMessage {
    const stream = Readable.from(
      init.body === undefined ? [] : [init.body]
    ) as unknown as Record<string, unknown>;
    stream.url = init.url;
    stream.method = init.method ?? "GET";
    stream.headers = init.headers ?? {};
    return stream as unknown as IncomingMessage;
  }

  test("a revoked device key kills a live CONTROL cookie and evicts its row", async () => {
    const token = "control-secret-token";
    const hash = hashControlToken(token);
    const controlStore = WebControlSessionStore.open();
    // Seed a persisted control row bound to a device key.
    controlStore.establish({
      tokenHash: hash,
      vaultId: "v1",
      deviceKey: "dev-1",
      shellOrigin: SHELL,
    });

    let enrolled = true;
    const sessions = new WebControlSessions({
      controlStore,
      isDeviceValid: () => enrolled,
    });
    const control = (): IncomingMessage =>
      req({
        url: `/centraid/_web/control?path=${encodeURIComponent("/centraid/_apps")}`,
        headers: { cookie: `__centraid_control=${token}`, origin: SHELL },
      });

    // Enrolled → authorizes as the device plane.
    expect(sessions.authorize(control())).toStrictEqual({
      plane: "device",
      deviceKey: "dev-1",
    });

    // Revoke the enrollment → the very next authorize fails and drops the row.
    enrolled = false;
    expect(sessions.authorize(control())).toBeUndefined();
    expect(controlStore.find(hash)).toBeUndefined();
  });
});
