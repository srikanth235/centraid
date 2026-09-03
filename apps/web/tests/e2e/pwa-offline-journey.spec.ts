import path from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { SERVICE_WORKER_VERSION } from "../../src/sw-version.js";
import { GATEWAY_ENDPOINT_ID, connectPwa } from "./connect.js";
import { setHarnessControlOnline } from "./control-transport.js";

const SHELL_CACHE = `centraid-shell-${SERVICE_WORKER_VERSION}`;
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const EVIDENCE_DIR = path.join(REPO_ROOT, "artifacts/e2e/ui-impact");
const EVIDENCE_PNG = "issue-892-pwa-offline-shell.png";

async function serviceWorkerReady(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async (cacheName) => {
          if (!("serviceWorker" in navigator)) return false;
          const registration = await navigator.serviceWorker.ready;
          if (!registration.active || !navigator.serviceWorker.controller) {
            return false;
          }
          if (!(await caches.has(cacheName))) return false;
          const cache = await caches.open(cacheName);
          return (await cache.keys()).length > 0;
        }, SHELL_CACHE),
      {
        timeout: 60_000,
        message: `no controlling service worker with a warm ${SHELL_CACHE}`,
      }
    )
    .toBe(true);
}

test("the shell, the session and recovery all survive a real browser offline", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);

  await connectPwa(page);
  await serviceWorkerReady(page);

  await setHarnessControlOnline(page, false);
  await context.setOffline(true);

  await page.reload();
  await expect(page.locator('nav[aria-label="Apps"]').first()).toBeVisible({
    timeout: 30_000,
  });

  expect(
    await page.evaluate(
      () => document.querySelector("#root")?.childElementCount ?? 0
    )
  ).toBeGreaterThan(0);

  expect(
    await page.evaluate(() =>
      localStorage.getItem("centraid.web.v1.connection")
    )
  ).toContain(GATEWAY_ENDPOINT_ID);

  await page.screenshot({
    path: path.join(EVIDENCE_DIR, EVIDENCE_PNG),
    fullPage: true,
  });

  await context.setOffline(false);
  await setHarnessControlOnline(page, true);
  await expect(page.locator('nav[aria-label="Apps"]').first()).toBeVisible({
    timeout: 30_000,
  });
});
