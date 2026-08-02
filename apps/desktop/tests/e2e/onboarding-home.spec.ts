import { mkdir } from "node:fs/promises";
import path from "node:path";

import { test, expect } from "@playwright/test";

import {
  appEntry,
  cleanupEnv,
  clickMenuItem,
  closeApp,
  launchApp,
  makeEnv,
  markUserApp,
  openTile,
  openTileMenu,
  seedRemoteGateway,
  startMockGateway,
  waitForHome,
} from "./fixtures";
import type { MockGateway, TestEnv } from "./fixtures";

/** §1 Onboarding & first run, §2 Home / app tiles. */

let env: TestEnv;
let gateway: MockGateway;

test.beforeEach(async () => {
  env = await makeEnv();
  gateway = await startMockGateway();
});

test.afterEach(async () => {
  await gateway.close().catch(() => undefined);
  await cleanupEnv(env);
});

// ─────────────────────────── §1 Onboarding ───────────────────────────

test("1.1 — first launch shows onboarding with the CTA disabled until a name is entered", async () => {
  await seedRemoteGateway(env, gateway, { onboarding: true });
  const { app, page } = await launchApp(env);
  try {
    // Desktop first run is chooser-first (#603). Identity now comes LAST and
    // only when the roster has no name for this person, so reach it via the
    // fresh path: connect is instant there, then the service offer, then the
    // name field whose CTA gating is under test.
    const chooser = page.getByTestId("first-run-choice");
    await chooser.waitFor({ state: "visible" });
    await chooser
      .getByRole("button", { name: /start fresh on this mac/iu })
      .click();
    await page.getByTestId("onboarding-view").waitFor({ state: "visible" });
    // The fresh path dials its own gateway and goes straight to identity — the
    // H5 service offer is no longer a blocking step (it lives on the Gateway
    // screen now), so there is nothing to decline here.
    const name = page.getByRole("textbox", { name: "Your name" });
    await name.waitFor({ state: "visible", timeout: 60_000 });
    const cta = page.getByRole("button", { name: "Continue" });
    await expect(cta).toBeDisabled();
    await name.fill("Ada Lovelace");
    await expect(cta).toBeEnabled();
    // Clearing the name disables it again.
    await name.fill("");
    await expect(cta).toBeDisabled();
  } finally {
    await closeApp(app);
  }
});

test('1.2 — "Start fresh on this Mac" auto-founds Shared + Personal and lands on home', async () => {
  // Issue #603 replaced the founding ceremony (create-vault + recovery-kit
  // download + verify) with a two-option chooser. On a virgin install the
  // desktop deliberately does NOT start its local gateway until the user picks
  // "Start fresh on this Mac" — that start is what would otherwise pop an OS
  // keychain prompt before any UI. The gateway then founds Shared + Personal
  // itself; the profile step renames Personal to the user's display name.
  const { app, page } = await launchApp(env);
  try {
    const chooser = page.getByTestId("first-run-choice");
    await chooser.waitFor({ state: "visible" });

    // Lazy-start AC: nothing has resolved a local gateway URL yet, so no
    // keychain write has happened.
    const beforeConnect = (await page.evaluate(() =>
      window.CentraidApi.getSettings()
    )) as {
      gatewayUrl?: string;
    };
    expect(beforeConnect.gatewayUrl ?? "").toBe("");

    await chooser
      .getByRole("button", { name: /start fresh on this mac/iu })
      .click();

    const onboarding = page.getByTestId("onboarding-view");
    await onboarding.waitFor({ state: "visible" });

    // The fresh/local path connects on mount and lands directly on identity —
    // the gateway just founded itself, so its owner is still the placeholder
    // "You" and the name is genuinely unknown. The H5 OS-service install is no
    // longer asked here; it is an opt-in tip on the Gateway screen.
    const nameField = page.getByRole("textbox", { name: "Your name" });
    await nameField.waitFor({ state: "visible", timeout: 60_000 });
    await nameField.fill("Ada Lovelace");
    // Pick a specific swatch.
    await onboarding.getByRole("radio").nth(2).click();
    await page.getByRole("button", { name: "Continue" }).click();

    // Onboarding view gone, home shell present.
    await onboarding.waitFor({ state: "detached" });
    await waitForHome(page);
    const evidenceDir = path.resolve(
      import.meta.dirname,
      "../../../../artifacts/e2e/ui-impact"
    );
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({
      path: path.join(evidenceDir, "issue-679-first-run-home.png"),
      fullPage: true,
    });

    // Persisted flag means a relaunch would skip onboarding, and the local
    // gateway is now really running.
    const persisted = (await page.evaluate(() =>
      window.CentraidApi.getSettings()
    )) as {
      onboardingCompletedAt?: string;
      gatewayUrl?: string;
    };
    expect(persisted.onboardingCompletedAt).toBeTruthy();
    expect(persisted.gatewayUrl ?? "").not.toBe("");

    // Two auto-founded vaults, with Personal renamed to the display name.
    const listed = (await page.evaluate(() =>
      window.CentraidApi.listGatewayVaults({ gatewayId: "local" })
    )) as { vaults?: Array<{ name: string }> };
    const names = (listed.vaults ?? []).map((vault) => vault.name).sort();
    expect(names).toEqual(["Ada Lovelace", "Shared"]);
  } finally {
    await closeApp(app);
  }
});

test("1.4 — a returning user (onboarding already complete) boots straight to home", async () => {
  await seedRemoteGateway(env, gateway); // onboarding complete by default
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await expect(page.getByTestId("onboarding-view")).toHaveCount(0);
  } finally {
    await closeApp(app);
  }
});

// ─────────────────────────── §2 Home / tiles ───────────────────────────

test("2.1 — home renders tiles with the right badges (draft vs new)", async () => {
  gateway.state.apps = [
    appEntry({ id: "published-old", name: "Established" }),
    appEntry({ id: "a-draft", name: "A Draft" }),
  ];
  await seedRemoteGateway(env, gateway);
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    // Adopt one app into userApps (recent) → "new" badge; reload to reclassify.
    await markUserApp(page, { id: "published-old", name: "Established" });
    await page.reload();
    await waitForHome(page);

    // The unadopted gateway app is a draft.
    const draftPill = page
      .locator('[data-app-id="a-draft"]')
      .getByTestId("status-pill");
    await expect(draftPill).toBeVisible();
    await expect(draftPill).toHaveAttribute("data-tone", "draft");
    // The adopted, freshly-created app shows the "new" badge.
    const newPill = page
      .locator('[data-app-id="published-old"]')
      .getByTestId("status-pill");
    await expect(newPill).toBeVisible();
    await expect(newPill).toHaveAttribute("data-tone", "new");
  } finally {
    await closeApp(app);
  }
});

test("2.2 — empty state renders the shelf-empty card with the composer still present", async () => {
  gateway.state.apps = [];
  await seedRemoteGateway(env, gateway);
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await expect(page.getByTestId("home-composer")).toBeVisible();
    // Realigned: the shelf's default filter is "All", whose empty copy is
    // "Nothing here yet" — "No apps yet" is now only the Apps-filtered empty
    // state (HomeScreen.tsx:272-295). Assert both: the default card, then the
    // Apps tab's.
    const empty = page.getByTestId("shelf-empty");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("Nothing here yet");
    await page.getByRole("tab", { name: "Apps" }).click();
    await expect(empty).toContainText("No apps yet");
  } finally {
    await closeApp(app);
  }
});

test("2.3 — renaming a tile via the context menu patches meta and shows a toast", async () => {
  const id = "rename-me";
  gateway.state.apps = [appEntry({ id, name: "Old Name" })];
  await seedRemoteGateway(env, gateway);
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await markUserApp(page, { id, name: "Old Name" });
    await page.reload();
    await waitForHome(page);

    await openTileMenu(page, id);
    await clickMenuItem(page, "Rename");
    // Realigned: renaming is a prompt modal now, not an inline editable name
    // field — HomeRoute.tsx:176-195 (`openPrompt({ title: 'Rename app' })`),
    // shell/prompt.ts builds the role=dialog + text input + Rename button.
    const dialog = page.getByRole("dialog", {
      name: "Rename app",
      exact: true,
    });
    await dialog.waitFor({ state: "visible" });
    await dialog.getByRole("textbox").fill("New Name");
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();

    await expect(page.locator("[data-global-toast]")).toContainText(
      /Renamed/iu
    );
    // The meta POST went to the gateway.
    expect(
      gateway.calls.some(
        (c) =>
          c.method === "POST" &&
          /\/centraid\/_apps\/.*\/meta$/u.test(c.pathname)
      )
    ).toBe(true);
  } finally {
    await closeApp(app);
  }
});

test("2.5 — the tile context menu exposes Open / Edit / Rename / Star / Delete", async () => {
  const id = "menu-app";
  gateway.state.apps = [appEntry({ id, name: "Menu App" })];
  await seedRemoteGateway(env, gateway);
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await markUserApp(page, { id, name: "Menu App" });
    await page.reload();
    await waitForHome(page);
    await openTileMenu(page, id);
    const items = page.getByRole("menu").getByRole("menuitem");
    // Realigned: "Share" (a stub) and "Reveal in Finder" were dropped from the
    // installed-app menu and "Star" added — HomeRoute.tsx:91-96 and :114-123
    // spell the current item list out, including the removal rationale.
    await expect(items).toContainText([
      "Open",
      "Edit with Centraid",
      "Rename",
      "Star",
      "Delete",
    ]);
  } finally {
    await closeApp(app);
  }
});

test("2.6 — clicking a tile opens the app view iframe", async () => {
  const id = "open-me";
  gateway.state.apps = [appEntry({ id, name: "Open Me" })];
  await seedRemoteGateway(env, gateway);
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await markUserApp(page, { id, name: "Open Me" });
    await page.reload();
    await waitForHome(page);
    await openTile(page, id);
    await expect(page.getByTestId("app-view")).toBeVisible();
    await expect(page.locator("iframe[data-centraid-app]")).toHaveCount(1);
  } finally {
    await closeApp(app);
  }
});

test("2.7 — the sidebar toggle flips the window sidebar state", async () => {
  gateway.state.apps = [];
  await seedRemoteGateway(env, gateway);
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    const win = page.locator("[data-sidebar]");
    await expect(win).toHaveAttribute("data-sidebar", "open");
    await page.locator('button[aria-label="Hide sidebar"]').first().click();
    await expect(win).toHaveAttribute("data-sidebar", "closed");
    await page.locator('button[aria-label="Show sidebar"]').first().click();
    await expect(win).toHaveAttribute("data-sidebar", "open");
  } finally {
    await closeApp(app);
  }
});

test("2.8 — the command palette opens from the sidebar Search item", async () => {
  gateway.state.apps = [];
  await seedRemoteGateway(env, gateway);
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    // The sidebar Search item renders its ⌘K shortcut inside the button, so its
    // accessible name is "Search ⌘K" (Sidebar.tsx:354-360) — `gotoNav`'s exact
    // match doesn't fit.
    await page.getByRole("button", { name: /^Search\s*⌘K$/u }).click();
    const palette = page.getByRole("dialog", {
      name: "Command palette",
      exact: true,
    });
    await expect(palette).toBeVisible();
    await expect(palette.getByRole("textbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
  } finally {
    await closeApp(app);
  }
});
