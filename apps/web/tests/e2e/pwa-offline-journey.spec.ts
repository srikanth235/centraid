import path from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { SERVICE_WORKER_VERSION } from "../../src/sw-version.js";
import { GATEWAY_ENDPOINT_ID, connectPwa } from "./connect.js";
import { setHarnessControlOnline } from "./control-transport.js";

/**
 * THE PWA'S CORE PROMISE, AT THE BROWSER LEVEL (#892 Phase 2).
 *
 * Centraid's web surface claims to work when the network does not. Three specs
 * already circle that claim — `offline-reconnect` proves a queued write settles
 * once, `offline-search` proves the local index answers, `web-pwa-cache` drives
 * the service worker's tunnel cache directly — and ALL THREE sever an
 * APPLICATION-LEVEL transport. None of them ever takes the BROWSER offline, so
 * the one thing a member experiences first — reloading the tab on a train and
 * getting the app rather than the dinosaur — was asserted nowhere.
 *
 * `context.setOffline(true)` is the difference, and it is not a nicety: with the
 * network genuinely down, the navigation request itself must be answered by the
 * service worker out of `centraid-shell-<version>`. A harness that only stops
 * answering RPCs leaves the document fetch working, so the shell-cache path — the
 * whole reason the SW pre-caches a shell at all — never runs.
 *
 * The journey, in the order a member lives it:
 *
 *   1. connect, and let the SW take control and bank the shell
 *   2. go offline for real
 *   3. RELOAD — the shell is served from cache, not from the network
 *   4. the connected session survives (no re-onboarding on a train)
 *   5. come back online — the app recovers without a manual reload
 *
 * Deliberately NOT re-asserted here: that a queued write settles exactly once.
 * `offline-reconnect.spec.ts` owns that claim and owns it well; duplicating it
 * would give the same law two owners, which this repo's matrix treats as a defect
 * in its own right.
 */

const SHELL_CACHE = `centraid-shell-${SERVICE_WORKER_VERSION}`;
// Repo-root `artifacts/`, the same convention every other evidence-emitting
// spec uses, so `bun run check:ui-receipt` and the nightly artifact upload agree
// about where the picture is.
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const EVIDENCE_DIR = path.join(REPO_ROOT, "artifacts/e2e/ui-impact");
const EVIDENCE_PNG = "issue-892-pwa-offline-shell.png";

/**
 * Wait until a service worker CONTROLS this page and the shell cache is warm.
 *
 * Both halves are load-bearing and neither implies the other: a registered but
 * uncontrolling worker does not intercept the next navigation, and a controlling
 * worker whose install has not finished pre-caching has nothing to serve. Going
 * offline before either is true would produce a failure about the network, not
 * about the shell.
 */
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

  // The gateway transport goes down with the network — a member on a train has
  // neither. Severing only one would be the state the existing specs already
  // cover; severing both is the state this one is about.
  await setHarnessControlOnline(page, false);
  await context.setOffline(true);

  // THE CLAIM. A reload with no network at all: every byte of this document and
  // its module graph comes out of the shell cache or nothing renders.
  await page.reload();
  await expect(page.locator('nav[aria-label="Apps"]').first()).toBeVisible({
    timeout: 30_000,
  });

  // And it is the APP, not a browser error page dressed up as one. `#root`
  // having children is the cheapest assertion that the module graph — not just
  // index.html — came back.
  expect(
    await page.evaluate(
      () => document.querySelector("#root")?.childElementCount ?? 0
    )
  ).toBeGreaterThan(0);

  // The session survived. Being offline must never look like being logged out:
  // an offline reload that dropped the member back to the connect screen would
  // be the same bug as losing the vault, from where they stand.
  expect(
    await page.evaluate(() =>
      localStorage.getItem("centraid.web.v1.connection")
    )
  ).toContain(GATEWAY_ENDPOINT_ID);

  // THE VISUAL EVIDENCE, and the one screenshot this change owes a reviewer.
  // Every assertion above is a locator or a storage read; none of them can show
  // that what came back out of the cache is the app a member recognises rather
  // than a skeleton that satisfies the selectors. This is the picture of the
  // product with the network genuinely off.
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, EVIDENCE_PNG),
    fullPage: true,
  });

  // Coming back is not a manual step. The shell must recover on its own once the
  // network and the transport return — a member does not know to press reload.
  await context.setOffline(false);
  await setHarnessControlOnline(page, true);
  await expect(page.locator('nav[aria-label="Apps"]').first()).toBeVisible({
    timeout: 30_000,
  });
});
