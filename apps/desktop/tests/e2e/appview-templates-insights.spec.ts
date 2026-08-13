import { promises as fs } from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";
import type * as TypeImport_11i4z7t from "@playwright/test";

import {
  appEntry,
  closeApp,
  cleanupEnv,
  gotoNav,
  launchApp,
  makeEnv,
  markUserApp,
  openTile,
  seedRemoteGateway,
  startBuilderFromPalette,
  startMockGateway,
  waitForHome,
} from "./fixtures";
import type { MockGateway, TestEnv } from "./fixtures";

/** §7 App view + in-app chat, §10 automation templates + drafts, §11 Insights. */

let env: TestEnv;
let gateway: MockGateway;

test.beforeEach(async () => {
  env = await makeEnv();
  gateway = await startMockGateway({ appsDir: env.appsDir });
  await seedRemoteGateway(env, gateway);
});

test.afterEach(async () => {
  await gateway.close().catch(() => undefined);
  await cleanupEnv(env);
});

async function openApp(
  page: TypeImport_11i4z7t.Page,
  id: string,
  name: string
): Promise<void> {
  await waitForHome(page);
  await markUserApp(page, { id, name });
  await page.reload();
  await waitForHome(page);
  await openTile(page, id);
  await page.getByTestId("inline-app-view").waitFor({ state: "visible" });
}

// ─────────────────────────── §7 app view + chat ───────────────────────────

test("7.1 — opening a system app renders inline; back returns home", async () => {
  gateway.state.apps = [appEntry({ id: "notes", name: "Notes" })];
  const { app, page } = await launchApp(env);
  try {
    await openApp(page, "notes", "Notes");
    await expect(page.getByTestId("inline-app-view")).toBeVisible();
    await expect(page.locator("iframe[data-centraid-app]")).toHaveCount(0);
    await page.keyboard.press("Meta+[");
    await waitForHome(page);
    // Home is the content springboard now (#708), not the library apps-grid.
    await expect(
      page.locator(
        '[data-testid="home-springboard"], [data-testid="home-first-run"]'
      )
    ).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

// §7.2-7.4 are skipped, not deleted: the surface they drive no longer exists
// in the shell, and the surface that replaced it is unreachable from this
// harness.
//
//  - The shell's "Ask <App>" FAB + slide-in copilot panel was removed
//    deliberately (see the rationale comment in
//    packages/client/src/react/shell/routes/AppViewRoute.tsx): its hit area
//    intercepted the kit Ask panel's send button, so the kit panel every
//    blueprint app ships is the sole Ask affordance now.
//  - The kit panel lives inside the sandboxed app iframe, and this harness's
//    mock gateway never serves blueprint bundles. Probed: the iframe for an
//    installed app resolves to `/centraid/<id>/`, which falls through to the
//    mock's catch-all `{}` (fixtures.ts), so the frame's body is literally
//    `<pre>{}</pre>` — Chromium's JSON viewer — with zero Ask affordances.
//
// Un-skipping is tracked in
// https://github.com/srikanth235/centraid/issues/470 (teach the mock to serve
// blueprint bundles + the kit). Do not "fix" these by reinstating the old
// `.app-chat-*` selectors — they address a removed feature.
//
// #496 P1/P8 — matrix note desktop.copilot-e2e: journey ownership moved to
// packages/agent-runtime/src/backends/acp/journey.integration.test.ts (fake-acp
// message → vault side effect → transcript). These Playwright skips stay until
// the mock serves blueprint kits; they must not be un-skipped against dead UI.

test.skip("7.2 — the chat FAB opens the copilot panel", async () => {
  gateway.state.apps = [appEntry({ id: "notes", name: "Notes" })];
  const { app, page } = await launchApp(env);
  try {
    await openApp(page, "notes", "Notes");
    await page.locator(".app-chat-fab").click();
    await expect(page.locator(".app-chat-panel.open")).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

test.skip("7.3 — a chat turn streams an assistant reply and a SQL tool result", async () => {
  gateway.state.apps = [appEntry({ id: "notes", name: "Notes" })];
  gateway.state.turnFrames = [
    { data: { type: "assistant.start" }, delayMs: 20 },
    {
      data: { type: "assistant.delta", delta: "Let me check your notes." },
      delayMs: 20,
    },
    {
      data: {
        type: "tool.start",
        toolCallId: "t1",
        toolName: "vault_sql",
        sql: "SELECT count(*) FROM notes_note",
      },
      delayMs: 20,
    },
    {
      data: {
        type: "tool.result",
        toolCallId: "t1",
        toolName: "vault_sql",
        ok: true,
        result: { rows: [[3]] },
      },
      delayMs: 20,
    },
    {
      data: { type: "assistant.delta", delta: " You have 3 notes." },
      delayMs: 20,
    },
    { data: { type: "final", text: "You have 3 notes." }, delayMs: 20 },
  ];
  const { app, page } = await launchApp(env);
  try {
    await openApp(page, "notes", "Notes");
    await page.locator(".app-chat-fab").click();
    await expect(page.locator(".app-chat-panel.open")).toBeVisible();

    await page.locator(".app-chat-textarea").fill("How many notes do I have?");
    await page.locator(".app-chat-textarea").press("Enter");

    await expect(page.locator(".msg-user-bubble")).toContainText(
      "How many notes"
    );
    await expect(
      page.locator(".msg-ai-text", { hasText: "3 notes" })
    ).toBeVisible({
      timeout: 10_000,
    });
    // The streamed tool call rendered a tool group in the transcript.
    await expect(
      page
        .locator(
          '.app-chat-scroll .tool-group, .app-chat-scroll [class*="tool"]'
        )
        .first()
    ).toBeVisible({ timeout: 10_000 });
    expect(
      gateway.calls.some(
        (c) => c.method === "POST" && /\/centraid\/.*\/_turn$/u.test(c.pathname)
      )
    ).toBe(true);
  } finally {
    await closeApp(app);
  }
});

test.skip("7.4 — the copilot past-chats history lists prior sessions and filters by search", async () => {
  gateway.state.apps = [appEntry({ id: "notes", name: "Notes" })];
  gateway.state.conversations = [
    {
      id: "c1",
      originAppId: "notes",
      title: "Grocery list",
      harnessKind: null,
      harnessSessionId: null,
      turnCount: 2,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_500_000,
      messageCount: 4,
    },
    {
      id: "c2",
      originAppId: "notes",
      title: "Trip planning",
      harnessKind: null,
      harnessSessionId: null,
      turnCount: 1,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_400_000,
      messageCount: 2,
    },
  ];
  const { app, page } = await launchApp(env);
  try {
    await openApp(page, "notes", "Notes");
    await page.locator(".app-chat-fab").click();
    await expect(page.locator(".app-chat-panel.open")).toBeVisible();

    // Open the ⋯ overflow and pick "Chat history".
    await page
      .locator(
        '.app-chat-overflow-wrap .app-chat-icon-btn[aria-label="More actions"]'
      )
      .click();
    await page
      .locator(".app-chat-overflow-item", { hasText: "Chat history" })
      .click();

    // Both sessions render in the history list.
    await expect(page.locator(".app-chat-history-row")).toHaveCount(2, {
      timeout: 10_000,
    });
    await expect(
      page.locator(".app-chat-history-title", { hasText: "Grocery list" })
    ).toBeVisible();
    expect(
      gateway.calls.some(
        (c) =>
          c.method === "GET" &&
          c.pathname.endsWith("/_centraid-conversations/apps/notes/sessions")
      )
    ).toBe(true);

    // Searching narrows to one.
    await page.locator(".app-chat-history-search").fill("trip");
    await expect(page.locator(".app-chat-history-row")).toHaveCount(1);
    await expect(
      page.locator(".app-chat-history-title", { hasText: "Trip planning" })
    ).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

// ────────────────────── §10 Automation templates / drafts ──────────────────────
//
// Discover retired with #708 — every first-party app ships installed, so the
// only catalogue left is the automation gallery, reached from Automations →
// Browse templates. Its cases (10.1 "renders template cards", 10.4 "empty
// Discover") went with the page; adoption is covered by 10.2 below.

test("10.2 — an automation template clone survives a fresh gateway instance and Electron process", async () => {
  gateway.state.templates = [
    {
      // The gallery intentionally exposes only the v0 curated IDs.
      // Keep this fixture on that public catalog contract; a made-up id is
      // correctly filtered out before the card reaches the page.
      id: "obligation-extractor",
      name: "Daily Digest",
      desc: "Summarize the day",
      colorKey: "violet",
      iconKey: "Todo",
      version: "1",
      kind: "automation",
      triggerKind: "cron",
      triggerLabel: "Every day",
    },
  ];
  gateway.state.cloneResult = {
    app: {
      id: "digest-clone",
      name: "Daily Digest",
      description: "Summarize the day",
      kind: "automation",
      hasIndex: true,
    },
    template: gateway.state.templates[0],
    webhooks: [],
  };
  let launched: Awaited<ReturnType<typeof launchApp>> | undefined =
    await launchApp(env);
  try {
    await waitForHome(launched.page);
    await gotoNav(launched.page, "Automations");
    await launched.page
      .getByRole("button", { name: "Browse templates" })
      .click();
    await launched.page.getByRole("button", { name: /Daily Digest/u }).click();
    await launched.page
      .getByRole("dialog", { name: "Daily Digest template" })
      .getByRole("button", { name: /Use template/u })
      .click();
    await expect
      .poll(
        () =>
          gateway.calls.some(
            (c) =>
              c.method === "POST" && c.pathname === "/centraid/_apps/_clone"
          ),
        { timeout: 10_000 }
      )
      .toBe(true);
    await expect.poll(() => gateway.state.automations).toHaveLength(1);

    // Cloning must NOT consume the source template — it stays adoptable in the
    // gallery until the user publishes (the invariant the retired agent-e2e
    // flows owned: "template tile disappeared after clone — expected templates
    // to remain available until publish"). Adopt navigates to the new thread,
    // so return to the gallery and assert the Daily Digest card is still listed.
    await gotoNav(launched.page, "Automations");
    // The clone left one automation behind, so the page is no longer empty and
    // its empty-state verb ("Browse templates", used earlier in this test) is
    // gone. With a populated list the way to the gallery is the app bar's
    // secondary (#765) — same destination, different door.
    await launched.page
      .getByRole("button", { name: "Templates" })
      .first()
      .click();
    await expect(
      launched.page.getByRole("button", { name: /Daily Digest/u })
    ).toBeVisible();

    // #765 UI evidence. This is the v9 binding layer on a POPULATED operational
    // page — app-bar verbs (filled commit + quiet secondary), the status line,
    // and the block vocabulary drawing real rows rather than an empty state.
    // An empty page would prove nothing about the blocks, which is why the
    // capture sits here, after the clone, rather than at first paint.
    const evidenceDir = path.resolve(
      import.meta.dirname,
      "../../../../artifacts/e2e/ui-impact"
    );
    await fs.mkdir(evidenceDir, { recursive: true });
    await launched.page.screenshot({
      path: path.join(evidenceDir, "issue-765-v9-binding-layer.png"),
      fullPage: true,
    });

    const manifestPath = path.join(env.appsDir, "digest-clone", "app.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      id: string;
      name: string;
    };
    expect(manifest).toMatchObject({
      id: "digest-clone",
      name: "Daily Digest",
    });

    await closeApp(launched.app);
    launched = undefined;
    await gateway.close();
    gateway = await startMockGateway({ appsDir: env.appsDir });
    await seedRemoteGateway(env, gateway);

    launched = await launchApp(env);
    await waitForHome(launched.page);
    await gotoNav(launched.page, "Automations");
    await expect(
      launched.page.getByRole("button", { name: /Daily Digest/u })
    ).toBeVisible();
    await expect(fs.access(manifestPath)).resolves.toBeUndefined();
  } finally {
    if (launched) await closeApp(launched.app);
  }
});

test("10.3 — independent builder drafts coexist on disk and survive a full Electron restart", async () => {
  const prompts = [
    "Track hydration",
    "Plan daily todos",
    "Keep a private journal",
  ];
  let launched = await launchApp(env);
  try {
    // Each draft must survive a complete app restart before the next one is
    // created, so the state transition is intentionally serial.
    const createNextDraft = async (index: number): Promise<void> => {
      const prompt = prompts[index];
      if (prompt === undefined) return;
      await waitForHome(launched.page);
      // Home composer is gone (#708); palette Create carries the initialPrompt.
      await startBuilderFromPalette(launched.page, prompt);
      await expect
        .poll(() => gateway.state.apps.length, { timeout: 10_000 })
        .toBe(index + 1);
      await closeApp(launched.app);
      launched = await launchApp(env);
      return createNextDraft(index + 1);
    };
    await createNextDraft(0);
    await waitForHome(launched.page);
    const draftIds = gateway.state.apps.map((entry) => entry.id).sort();
    const appDirectories = (await fs.readdir(env.appsDir)).sort();
    expect(appDirectories).toEqual(draftIds);
    await Promise.all(
      draftIds.map(async (id) => {
        const manifest = JSON.parse(
          await fs.readFile(path.join(env.appsDir, id, "app.json"), "utf8")
        ) as { id: string; name: string };
        expect(manifest.id).toBe(id);
        expect(manifest.name.length).toBeGreaterThan(0);
      })
    );
    await closeApp(launched.app);

    const restarted = await launchApp(env);
    try {
      await waitForHome(restarted.page);
      // Drafts no longer appear as Home library cards (#708); survive on disk
      // and remain openable via the palette.
      await Promise.all(
        draftIds.map(async (id) => {
          await expect(
            fs.access(path.join(env.appsDir, id, "app.json"))
          ).resolves.toBeUndefined();
        })
      );
    } finally {
      await closeApp(restarted.app);
    }
  } finally {
    await closeApp(launched.app).catch(() => undefined);
  }
});

// ─────────────────────────── §11 Analytics (was Insights) ───────────────────────────

test("11.1 — Analytics renders the runs chart and what it cost", async () => {
  gateway.state.insights = {
    windowDays: 30,
    generatedAt: Date.now(),
    kpis: {
      totalTokens: 12345,
      unpricedRuns: 0,
      unreportedRuns: 0,
      totalCostUsd: 1.23,
      harnessReportedCostUsd: 1,
      estimatedCostUsd: 0.23,
      forecastCostUsd: 4.56,
      appsTouched: 3,
      generations: 7,
      retries: 1,
      failedRuns: 0,
      failedCostUsd: 0,
    },
    daily: [
      { date: "2024-05-01", tokens: 5000, costUsd: 0.5, runs: 2 },
      { date: "2024-05-02", tokens: 7345, costUsd: 0.73, runs: 5 },
    ],
    bySource: [
      {
        key: "app/digest",
        label: "Digest",
        kind: "automation",
        runs: 3,
        tokens: 8000,
        costUsd: 0.8,
      },
    ],
    byHarness: [
      { harness: "claude-code", runs: 7, tokens: 12345, costUsd: 1.23 },
    ],
    byModel: [{ model: "tier-deep", runs: 7, tokens: 12345, costUsd: 1.23 }],
    byEffort: [{ effort: "high", runs: 7, tokens: 12345, costUsd: 1.23 }],
    recent: [],
  };
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoNav(page, "Analytics");
    // v9 (#765): the spend hero and the KPI strip are gone. The page is the
    // runs chart — one image with a sentence — over the source facts, and the
    // spend is one of those facts rather than a headline figure.
    await expect(
      page.getByRole("img", { name: "Runs per day over the last 30 days" })
    ).toBeVisible();
    await expect(
      page.getByRole("group", { name: "Time window" })
    ).toBeVisible();
    // The spend fact, wherever the fact list puts it — the page states the
    // figure, it no longer headlines it.
    await expect(page.locator("body")).toContainText("$1.23");
  } finally {
    await closeApp(app);
  }
});
