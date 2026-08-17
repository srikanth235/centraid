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
  // built-in engines (one delegate-capable, one structurally not), one member
  // engine that reaches a provider, one scoped rule, and one answered egress
  // question.
  gateway.state.enrichProfiles = [
    {
      id: "built-in",
      label: "Built-in (ocr)",
      capability: "ocr",
      engine: { kind: "built-in" },
      egress: "gateway",
      builtIn: true,
      delegateCapable: true,
    },
    {
      id: "built-in",
      label: "Built-in (faces)",
      capability: "faces",
      engine: { kind: "built-in" },
      egress: "on-device",
      builtIn: true,
      delegateCapable: false,
    },
    {
      id: "ocr-codex",
      label: "Codex",
      capability: "ocr",
      engine: { kind: "delegate", harness: "codex" },
      egress: "provider",
      builtIn: false,
      delegateCapable: true,
    },
  ];
  // The page asks the ONE resolver per capability rather than folding the
  // cascade itself (issue #814), so the mock has to answer for each built-in
  // the profiles above declare.
  gateway.state.enrichEffective = {
    faces: {
      capability: "faces",
      enabled: true,
      profileId: "built-in",
      trigger: "on-ingest",
      egressCeiling: "on-device",
    },
    ocr: {
      capability: "ocr",
      enabled: true,
      profileId: "built-in",
      trigger: "on-view",
      egressCeiling: "on-device",
    },
  };
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

test("12.9 — Settings → Enrichment states what runs, and says when a stored ceiling stops it", async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoSettings(page);
    await page.getByTestId("settings-page").waitFor({ state: "visible" });
    await page
      .getByTestId("settings-nav")
      .getByRole("button", { name: /Enrichment/u })
      .click();

    const pane = page.getByTestId("settings-page");
    // WHERE ENRICHMENT RUNS IS NOT A CHOICE (v11): the per-domain ceiling
    // control is gone, and the group head counts its own rows instead.
    await expect(
      pane.getByRole("tablist", { name: "Enrichment for Photos" })
    ).toHaveCount(0);
    await expect(pane).toContainText("2 of 2 on");
    // A capability is a ROW: its plain name, what it gets you, and a switch.
    await expect(pane).toContainText("Text in photos");
    await expect(pane).toContainText("receipts, signs, whiteboards");
    await expect(pane).toContainText("Faces");
    // Faces is structurally undelegatable, so it is offered no engine at all
    // and carries its reassurance inside its own description.
    await expect(pane).toContainText(
      "Named only by you, and never sent to a provider."
    );
    // The ceiling lost its control, not its teeth: photos is stored at
    // `on-device` while the bundled OCR engine is gateway-lane, so the row
    // states the gate rather than reading as on and never running.
    await expect(pane).toContainText("Stopped by a stored ceiling");
    // The answered egress question reads as a sentence about the member.
    await expect(pane).toContainText("You declined");

    // The UI-receipt evidence for issue #814 (check:ui-receipt): the
    // Enrichment page as a first run finds it.
    const evidenceDir = path.resolve(
      import.meta.dirname,
      "../../../../artifacts/e2e/ui-impact"
    );
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({
      path: path.join(evidenceDir, "issue-814-enrichment-capabilities.png"),
      fullPage: true,
    });

    // The engine is collapsed behind one pill; pressing it reveals the chips,
    // and picking an agent creates the engine profile behind the row.
    await pane
      .getByRole("button", { name: "Built in", exact: true })
      .first()
      .click();
    await expect(
      pane.getByRole("button", { name: "Codex", exact: true })
    ).toBeVisible();

    // Flipping a switch writes ONE vault-scope rule through the owner route.
    await pane.getByLabel("Faces", { exact: true }).click();
    await expect
      .poll(() =>
        gateway.calls.some(
          (call) =>
            call.method === "PUT" &&
            call.pathname === "/centraid/_vault/enrich/rules" &&
            /"capability"\s*:\s*"faces"/u.test(call.body ?? "")
        )
      )
      .toBe(true);
  } finally {
    await closeApp(app);
  }
});
