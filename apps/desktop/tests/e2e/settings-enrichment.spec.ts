import { mkdir } from "node:fs/promises";
import path from "node:path";

import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  cleanupEnv,
  closeApp,
  launchApp,
  makeEnv,
  seedRemoteGateway,
  startMockGateway,
  waitForHome,
} from "./fixtures";
import type { MockGateway, TestEnv } from "./fixtures";

/** §12 Settings → Enrichment (issue #807). */

/** Open Settings from the All apps sheet — same route as settings-gateways. */
async function gotoSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: /All apps/iu }).click();
  await page
    .getByRole("dialog", { name: "All apps" })
    .getByRole("button", { name: "Settings", exact: true })
    .click();
}

let env: TestEnv;
let gateway: MockGateway;

test.beforeEach(async () => {
  env = await makeEnv();
  gateway = await startMockGateway();
  // Enough policy state for the page to render every group it owns: two
  // built-in engines, one member engine that reaches a provider, one scoped
  // rule, and one answered egress question.
  gateway.state.enrichProfiles = [
    {
      id: "built-in",
      label: "Built-in (ocr)",
      capability: "ocr",
      engine: { kind: "built-in" },
      egress: "gateway",
      builtIn: true,
    },
    {
      id: "built-in",
      label: "Built-in (faces)",
      capability: "faces",
      engine: { kind: "built-in" },
      egress: "on-device",
      builtIn: true,
    },
    {
      id: "sharp-ocr",
      label: "Sharp OCR",
      capability: "ocr",
      engine: { kind: "delegate", harness: "codex" },
      egress: "provider",
      builtIn: false,
    },
  ];
  gateway.state.enrichRules = [
    {
      scope: { type: "domain", ref: "photos" },
      capability: "ocr",
      enabled: true,
      profile: null,
      trigger: "on-view",
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
  ];
  gateway.state.enrichConsent = [
    {
      capability: "ocr",
      egress: "provider",
      scopeRef: "",
      decision: "declined",
      decidedAt: "2026-08-02T00:00:00.000Z",
      receiptId: null,
    },
  ];
  await seedRemoteGateway(env, gateway);
});

test.afterEach(async () => {
  await gateway.close().catch(() => undefined);
  await cleanupEnv(env);
});

test("12.9 — Settings → Enrichment states the policy and writes the tier the vault answers with", async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoSettings(page);
    await page.getByTestId("settings-page").waitFor({ state: "visible" });
    await page
      .getByTestId("settings-nav")
      .getByRole("button", { name: "Enrichment", exact: true })
      .click();

    const pane = page.getByTestId("settings-page");
    // The tier the gateway holds is what renders — `device` was seeded.
    const photos = pane.getByRole("tablist", { name: "Enrichment for Photos" });
    await expect(photos.getByRole("tab", { selected: true })).toHaveText(
      "On this device"
    );
    // Every group the page owns is present, with the gateway's own words.
    await expect(pane).toContainText("Sharp OCR");
    await expect(pane).toContainText("sent to a provider");
    await expect(pane).toContainText("Text in photos");
    await expect(pane).toContainText("declined");

    // The UI-receipt evidence for issue #807 (docs/… check:ui-receipt): the
    // Enrichment page as a first run finds it.
    const evidenceDir = path.resolve(
      import.meta.dirname,
      "../../../../artifacts/e2e/ui-impact"
    );
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({
      path: path.join(evidenceDir, "issue-807-enrichment-settings.png"),
      fullPage: true,
    });

    // Raising the tier writes the vault's route, and the page renders what
    // came back rather than what was clicked.
    await photos.getByRole("tab", { name: "On your gateway" }).click();
    await expect
      .poll(() =>
        gateway.calls.some(
          (call) =>
            call.method === "PUT" &&
            call.pathname === "/centraid/_vault/enrich" &&
            /"photos"\s*:\s*"gateway"/u.test(call.body ?? "")
        )
      )
      .toBe(true);
    await expect(photos.getByRole("tab", { selected: true })).toHaveText(
      "On your gateway"
    );
  } finally {
    await closeApp(app);
  }
});
