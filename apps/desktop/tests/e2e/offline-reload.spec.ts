import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  cleanupEnv,
  closeApp,
  launchApp,
  makeEnv,
  openAppFromPalette,
  seedRemoteGateway,
  waitForHome,
} from "./fixtures";
import type { TestEnv } from "./fixtures";

/*
 * §9 Offline durability — the pending-write overlay survives a reload (#738).
 *
 * The headline acceptance criterion of issue #738 is a browser-level claim on
 * this seat: add a Tally expense while the gateway is unreachable, reload the
 * app while it is STILL unreachable, and the expense is still in the ledger
 * with its pending chip, carried by nothing but the device's own durable
 * outbox. Every other test of that claim on desktop/web stubs
 * `window.centraid.pendingWrites()`, which is exactly the mechanism under
 * test — so this file is the one place the mechanism is not faked.
 *
 * WHY THIS FILE BRINGS ITS OWN GATEWAY. `fixtures.startMockGateway` cannot
 * serve this scenario, and neither can the desktop's own embedded gateway:
 *
 *   - the mock answers `{}` to `/centraid/_vault/status`, so no vault is ever
 *     addressed and `openReplicaShellSession` refuses ("An addressed vault is
 *     required"). It has no replica plane at all — no bootstrap, no catalog —
 *     and an inline blueprint with no catalog can neither read nor write.
 *   - the in-process embed the harness selects with
 *     `CENTRAID_EMBEDDED_GATEWAY=1` DOES found real vaults, but it passes no
 *     `devicePairing` to `serve()`, and `build-gateway` only hands the replica
 *     route handler an `EnrollmentStore` when `devicePairing` is present. With
 *     no store, `resolveReplicaAccess` answers `replica_device_not_enrolled`
 *     for every request, so the whole replica plane 403s under the embed.
 *
 * So the scenario runs the REAL daemon — the same `centraid-gateway serve`
 * binary the desktop spawns in production, which does wire `devicePairing` —
 * on its own port inside the test's disposable workspace, and reaches it
 * through the harness's existing remote-profile seam
 * (`CENTRAID_E2E_IROH_PROXY_MAP`). That seam replaces the iroh tunnel with a
 * plain URL and therefore also drops the tunnel's authentication, so the test
 * stands a one-hop loopback proxy in front that re-attaches the daemon's
 * bearer. The proxy is the wire; closing it is how the gateway becomes
 * unreachable, which is the same "close the server the app is talking to"
 * idiom `delete-app.spec.ts` §3.3 already uses for offline.
 */

let env: TestEnv;
let gateway: RealGateway | undefined;
let proxy: AuthProxy | undefined;

test.beforeEach(async () => {
  env = await makeEnv();
});

test.afterEach(async () => {
  await proxy?.close();
  await gateway?.close();
  proxy = undefined;
  gateway = undefined;
  await cleanupEnv(env);
});

// ─────────────────────────── the real daemon ───────────────────────────

interface RealGateway {
  url: string;
  token: string;
  close: () => Promise<void>;
}

/** How long the daemon gets to found its vaults and announce a port. */
const GATEWAY_READY_TIMEOUT_MS = 120_000;

/**
 * Start `centraid-gateway serve` against a data dir inside this test's
 * workspace. `port: 0` keeps it off any shared port and `endpoint: false`
 * keeps it off iroh — this scenario is a loopback story and must not depend
 * on a relay being reachable from CI.
 */
async function startRealGateway(target: TestEnv): Promise<RealGateway> {
  const cli = path.resolve(
    import.meta.dirname,
    "../../../../packages/gateway/dist/cli/cli.js"
  );
  await fs.access(cli).catch(() => {
    throw new Error(
      `${cli} not found. Build the gateway (\`bun run build\` at the repo root) before this spec.`
    );
  });
  const dataDir = path.join(target.workspace, "real-gateway");
  await fs.mkdir(dataDir, { recursive: true });
  const configFile = path.join(target.workspace, "real-gateway.config.json");
  await fs.writeFile(
    configFile,
    `${JSON.stringify({ dataDir, host: "127.0.0.1", port: 0, endpoint: false }, null, 2)}\n`
  );
  const token = crypto.randomBytes(32).toString("hex");
  const child = spawn(
    process.execPath,
    [cli, "serve", "--config", configFile],
    {
      env: { ...process.env, CENTRAID_GATEWAY_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const url = await announcedUrl(child);
  return { url, token, close: () => stopChild(child) };
}

/** Resolve on the daemon's own "listening on <url>" line; reject if it dies. */
function announcedUrl(child: ChildProcess): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let log = "";
    const timer = setTimeout(
      () =>
        reject(
          new Error(`gateway never announced a port: ${log.slice(-1000)}`)
        ),
      GATEWAY_READY_TIMEOUT_MS
    );
    const settle = (fn: () => void): void => {
      clearTimeout(timer);
      fn();
    };
    const onChunk = (chunk: Buffer): void => {
      log += chunk.toString("utf8");
      const url = /listening on (?<url>http:\/\/\S+)/u.exec(log)?.groups?.url;
      if (url) settle(() => resolve(url));
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.once("exit", (code) =>
      settle(() =>
        reject(new Error(`gateway exited with ${code}: ${log.slice(-1000)}`))
      )
    );
  });
}

/** SIGTERM the daemon and wait for the process boundary, like `closeApp`. */
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise<void>((resolve) => {
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5_000);
    }),
  ]);
}

// ─────────────────────────── the wire ───────────────────────────

interface AuthProxy {
  url: string;
  close: () => Promise<void>;
}

/**
 * One loopback hop in front of the daemon that re-attaches its bearer. In
 * production that job belongs to the iroh local proxy; the E2E resolver
 * (`setIrohProxyResolverForTests`) hands the desktop a bare URL instead, and a
 * bare URL carries no credential — `resolveGateway` deliberately returns an
 * empty token for a remote profile because the tunnel, not the renderer, is
 * what proves the device.
 *
 * Closing this is how the test cuts the wire: the daemon stays up (so teardown
 * is clean and nothing about the gateway's own state changes), and every
 * request from the renderer gets a connection refusal — indistinguishable, to
 * the app, from a gateway that has gone away.
 */
async function startAuthProxy(target: RealGateway): Promise<AuthProxy> {
  const upstream = new URL(target.url);
  const server = http.createServer((req, res) => {
    const forwarded = http.request(
      {
        host: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: {
          ...req.headers,
          host: upstream.host,
          authorization: `Bearer ${target.token}`,
        },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    forwarded.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(forwarded);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string")
    throw new Error("auth proxy: no address");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        // Long-poll change-feed requests hold sockets open; without this the
        // close never completes and "offline" never arrives.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ─────────────────────────── DOM helpers ───────────────────────────

const APP_VIEW = '[data-testid="app-view"], [data-testid="inline-app-view"]';

/** Reload the shell and come back into Tally, waiting for it to paint. */
async function reopenTally(page: Page): Promise<void> {
  await page.reload();
  await waitForHome(page);
  await openAppFromPalette(page, "Tally");
  await page.locator(APP_VIEW).waitFor({ state: "visible", timeout: 60_000 });
  await page
    .getByRole("button", { name: "Add an expense" })
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
}

/**
 * Ask the renderer itself whether the gateway answers. This is the scenario's
 * offline proof: an assertion about the app's own copy, not about the harness's
 * intent. A row that renders while this is `false` cannot have come from the
 * gateway.
 */
async function gatewayReachable(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const { baseUrl } = await window.CentraidApi.getGatewayAuth();
    try {
      await fetch(`${baseUrl}/centraid/_vault/status`, { cache: "no-store" });
      return true;
    } catch {
      return false;
    }
  });
}

// ─────────────────────────── the scenario ───────────────────────────

test("9.1 — an expense added offline survives a reload from the local outbox", async () => {
  // A real daemon founds two vaults and installs eight blueprints on first
  // boot, and the journey reloads the shell four times, so this is nothing
  // like a 60s test. The budget is generous on purpose: a timeout here should
  // mean something broke, not that the daemon was slow to found a vault.
  test.setTimeout(300_000);

  gateway = await startRealGateway(env);
  proxy = await startAuthProxy(gateway);
  await seedRemoteGateway(env, { url: proxy.url });

  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);

    // Offline durability is opt-in and OFF for a freshly seeded profile
    // (`seedRemoteGatewayProfile` writes `rememberDevice: false`). Without it
    // the replica opens in memory mode — `createReplicaCoordinator` only
    // reaches the IndexedDB outbox when the worker came up on OPFS — and a
    // reload would legitimately lose the queued write. This is the same
    // main-process handler Settings → This device's offline-copy switch calls,
    // so turning it on here IS the product gesture, not a test backdoor. The
    // reload is what makes the shell re-open its replica under the new answer.
    await page.evaluate(() =>
      window.CentraidApi.setGatewayRememberDevice({ rememberDevice: true })
    );
    await reopenTally(page);

    // ---- setup, online: a friend and a group to hold the expense ----
    // Tally refuses an expense outside a group ("expenses live inside a
    // group"), and a group needs one other member, so both are prerequisites
    // rather than scenery. Each is a real receipted write against the daemon.
    await page.getByRole("button", { name: "Add a friend" }).first().click();
    await page.getByPlaceholder("Name").fill("Grace Hopper");
    await page
      .locator(".kit-modal")
      .getByRole("button", { name: "Add friend" })
      .click();
    // Wait for the receipt, not a sleep: reloading mid-write would reopen the
    // shell over a write that had not landed yet.
    await expect(page.getByText(/Friend added · receipted/u)).toBeVisible({
      timeout: 30_000,
    });
    // Re-entering the app after each setup write is deliberate. Tally's
    // in-place refresh can land in the window where the inline bridge has been
    // torn down for a re-mount, and `window.centraid` is briefly undefined —
    // it surfaces as "Couldn't reach the vault" over a vault that is perfectly
    // reachable. That is its own defect; letting it decide this test would
    // turn an outbox scenario into a mount-race scenario.
    await reopenTally(page);
    await expect(page.getByText("Grace Hopper").first()).toBeVisible({
      timeout: 30_000,
    });

    await page
      .getByRole("button", { name: /Create a group|New group/iu })
      .first()
      .click();
    await page.getByPlaceholder("Group name").fill("Trip");
    await page
      .locator(".kit-modal")
      .getByRole("button", { name: /Grace/iu })
      .first()
      .click();
    await page
      .locator(".kit-modal")
      .getByRole("button", { name: /^Create group$/iu })
      .click();
    await expect(page.getByText(/Group created · receipted/u)).toBeVisible({
      timeout: 30_000,
    });
    await reopenTally(page);
    await expect(
      page.getByRole("button", { name: /Trip/u }).first()
    ).toBeVisible({ timeout: 30_000 });

    // Nothing named "Kayak rental" exists yet, so the row asserted at the end
    // can only be the one queued below.
    await expect(page.getByText("Kayak rental")).toHaveCount(0);

    // ---- the gateway goes away ----
    await proxy.close();
    proxy = undefined;
    await expect
      .poll(() => gatewayReachable(page), { timeout: 30_000 })
      .toBe(false);

    // ---- add the expense while unreachable ----
    await page.getByRole("button", { name: "Add an expense" }).first().click();
    const expenseModal = page.locator(".kit-modal");
    await expenseModal.waitFor({ state: "visible" });
    await page.getByPlaceholder("What was it for?").fill("Kayak rental");
    await page.getByPlaceholder("0.00").first().fill("42.50");
    await expenseModal.getByRole("button", { name: /^Save$/u }).click();
    await expenseModal.waitFor({ state: "detached" });

    // The group ledger is where Tally renders expense rows; the dashboard
    // carries balances only.
    await page.getByRole("button", { name: /Trip/u }).first().click();
    const queued = page
      .locator(".kit-pending")
      .filter({ hasText: "Kayak rental" });
    await expect(queued).toHaveCount(1, { timeout: 30_000 });
    await expect(queued).toContainText("you paid $42.50");
    await expect(queued.locator(".kit-pending-chip")).toHaveText("pending");

    // ---- reload, STILL unreachable ----
    await reopenTally(page);
    expect(await gatewayReachable(page)).toBe(false);

    await page.getByRole("button", { name: /Trip/u }).first().click();
    const restored = page
      .locator(".kit-pending")
      .filter({ hasText: "Kayak rental" });
    // One row, not two: the deterministic `pendingRowId(intentId)` means a
    // reload reconciles onto the same row rather than minting a second one.
    await expect(restored).toHaveCount(1, { timeout: 30_000 });
    // The row's own content — the description, the money it states, and the
    // chip. Asserting that "some pending element exists" would pass over an
    // empty ledger with a stray chip somewhere else on the page.
    await expect(restored).toContainText("Kayak rental");
    await expect(restored).toContainText("you paid $42.50");
    await expect(restored.locator(".kit-pending-chip")).toHaveText("pending");
    // Provenance, spelled out: both of these strings are reasons the CLIENT
    // stored on the intent when its ship attempt failed
    // (`markIntentTransportFailed` / the queued admission result). No gateway
    // answer contains either, and the gateway is not answering anyway — so a
    // row explaining itself this way after a reload was rebuilt from the
    // durable outbox and nothing else.
    await expect(restored).toContainText(
      /Could not reach gateway|saved locally/u
    );

    const evidenceDir = path.resolve(
      import.meta.dirname,
      "../../../../artifacts/e2e/ui-impact"
    );
    await fs.mkdir(evidenceDir, { recursive: true });
    // The frame is the group ledger holding the restored row — the surface the
    // claim is about. Screenshotting Home under this filename would satisfy the
    // ui-receipt gate and tell a reviewer nothing (see onboarding-home.spec.ts
    // §2.6b for the same warning).
    await page.screenshot({
      path: path.join(evidenceDir, "issue-738-pending-write-overlay.png"),
      fullPage: true,
    });
  } finally {
    await closeApp(app);
  }
});
