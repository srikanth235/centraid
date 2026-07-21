import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
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
  startMockGateway,
  waitForHome,
  type MockGateway,
  type TestEnv,
} from './fixtures';

/** §7 App view + in-app chat, §10 Templates / Discover, §11 Insights. */

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
  page: import('@playwright/test').Page,
  id: string,
  name: string,
): Promise<void> {
  await waitForHome(page);
  await markUserApp(page, { id, name });
  await page.reload();
  await waitForHome(page);
  await openTile(page, id);
  await page.getByTestId('app-view').waitFor({ state: 'visible' });
}

// ─────────────────────────── §7 app view + chat ───────────────────────────

test('7.1 — opening an app shows the iframe; back returns home', async () => {
  gateway.state.apps = [appEntry({ id: 'notes', name: 'Notes' })];
  const { app, page } = await launchApp(env);
  try {
    await openApp(page, 'notes', 'Notes');
    await expect(page.locator('iframe[data-centraid-app]')).toHaveCount(1);
    await page.keyboard.press('Meta+[');
    await waitForHome(page);
    await expect(page.getByTestId('apps-grid')).toBeVisible();
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

test.skip('7.2 — the chat FAB opens the copilot panel', async () => {
  gateway.state.apps = [appEntry({ id: 'notes', name: 'Notes' })];
  const { app, page } = await launchApp(env);
  try {
    await openApp(page, 'notes', 'Notes');
    await page.locator('.app-chat-fab').click();
    await expect(page.locator('.app-chat-panel.open')).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

test.skip('7.3 — a chat turn streams an assistant reply and a SQL tool result', async () => {
  gateway.state.apps = [appEntry({ id: 'notes', name: 'Notes' })];
  gateway.state.turnFrames = [
    { data: { type: 'assistant.start' }, delayMs: 20 },
    { data: { type: 'assistant.delta', delta: 'Let me check your notes.' }, delayMs: 20 },
    {
      data: {
        type: 'tool.start',
        toolCallId: 't1',
        toolName: 'vault_sql',
        sql: 'SELECT count(*) FROM notes_note',
      },
      delayMs: 20,
    },
    {
      data: {
        type: 'tool.result',
        toolCallId: 't1',
        toolName: 'vault_sql',
        ok: true,
        result: { rows: [[3]] },
      },
      delayMs: 20,
    },
    { data: { type: 'assistant.delta', delta: ' You have 3 notes.' }, delayMs: 20 },
    { data: { type: 'final', text: 'You have 3 notes.' }, delayMs: 20 },
  ];
  const { app, page } = await launchApp(env);
  try {
    await openApp(page, 'notes', 'Notes');
    await page.locator('.app-chat-fab').click();
    await expect(page.locator('.app-chat-panel.open')).toBeVisible();

    await page.locator('.app-chat-textarea').fill('How many notes do I have?');
    await page.locator('.app-chat-textarea').press('Enter');

    await expect(page.locator('.msg-user-bubble')).toContainText('How many notes');
    await expect(page.locator('.msg-ai-text', { hasText: '3 notes' })).toBeVisible({
      timeout: 10_000,
    });
    // The streamed tool call rendered a tool group in the transcript.
    await expect(
      page.locator('.app-chat-scroll .tool-group, .app-chat-scroll [class*="tool"]').first(),
    ).toBeVisible({ timeout: 10_000 });
    expect(
      gateway.calls.some((c) => c.method === 'POST' && /\/centraid\/.*\/_turn$/.test(c.pathname)),
    ).toBe(true);
  } finally {
    await closeApp(app);
  }
});

test.skip('7.4 — the copilot past-chats history lists prior sessions and filters by search', async () => {
  gateway.state.apps = [appEntry({ id: 'notes', name: 'Notes' })];
  gateway.state.conversations = [
    {
      id: 'c1',
      originAppId: 'notes',
      title: 'Grocery list',
      adapterKind: null,
      adapterSessionId: null,
      turnCount: 2,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_500_000,
      messageCount: 4,
    },
    {
      id: 'c2',
      originAppId: 'notes',
      title: 'Trip planning',
      adapterKind: null,
      adapterSessionId: null,
      turnCount: 1,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_400_000,
      messageCount: 2,
    },
  ];
  const { app, page } = await launchApp(env);
  try {
    await openApp(page, 'notes', 'Notes');
    await page.locator('.app-chat-fab').click();
    await expect(page.locator('.app-chat-panel.open')).toBeVisible();

    // Open the ⋯ overflow and pick "Chat history".
    await page
      .locator('.app-chat-overflow-wrap .app-chat-icon-btn[aria-label="More actions"]')
      .click();
    await page.locator('.app-chat-overflow-item', { hasText: 'Chat history' }).click();

    // Both sessions render in the history list.
    await expect(page.locator('.app-chat-history-row')).toHaveCount(2, { timeout: 10_000 });
    await expect(
      page.locator('.app-chat-history-title', { hasText: 'Grocery list' }),
    ).toBeVisible();
    expect(
      gateway.calls.some(
        (c) =>
          c.method === 'GET' && c.pathname.endsWith('/_centraid-conversations/apps/notes/sessions'),
      ),
    ).toBe(true);

    // Searching narrows to one.
    await page.locator('.app-chat-history-search').fill('trip');
    await expect(page.locator('.app-chat-history-row')).toHaveCount(1);
    await expect(
      page.locator('.app-chat-history-title', { hasText: 'Trip planning' }),
    ).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

// ─────────────────────────── §10 Discover / templates ───────────────────────────

test('10.1 — Discover renders template cards', async () => {
  gateway.state.templates = [
    {
      id: 'habit',
      name: 'Habit Tracker',
      desc: 'Track habits',
      colorKey: 'violet',
      iconKey: 'Todo',
      version: '1',
    },
    {
      id: 'journal',
      name: 'Journal',
      desc: 'Daily journal',
      colorKey: 'teal',
      iconKey: 'Todo',
      version: '1',
    },
  ];
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoNav(page, 'Discover');
    await expect(page.getByRole('button', { name: /Habit Tracker/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Journal/ })).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

test('10.2 — an automation template clone survives a fresh gateway instance and Electron process', async () => {
  gateway.state.templates = [
    {
      id: 'digest',
      name: 'Daily Digest',
      desc: 'Summarize the day',
      colorKey: 'violet',
      iconKey: 'Todo',
      version: '1',
      kind: 'automation',
      triggerKind: 'cron',
      triggerLabel: 'Every day',
    },
  ];
  gateway.state.cloneResult = {
    app: {
      id: 'digest-clone',
      name: 'Daily Digest',
      description: 'Summarize the day',
      kind: 'automation',
      hasIndex: true,
    },
    template: gateway.state.templates[0],
    webhooks: [],
  };
  let launched: Awaited<ReturnType<typeof launchApp>> | undefined = await launchApp(env);
  try {
    await waitForHome(launched.page);
    await gotoNav(launched.page, 'Discover');
    await launched.page.getByRole('button', { name: /Daily Digest/ }).click();
    await launched.page
      .getByRole('dialog', { name: 'Daily Digest template' })
      .getByRole('button', { name: /Use template/ })
      .click();
    await expect
      .poll(
        () =>
          gateway.calls.some((c) => c.method === 'POST' && c.pathname === '/centraid/_apps/_clone'),
        { timeout: 10_000 },
      )
      .toBe(true);
    await expect.poll(() => gateway.state.automations).toHaveLength(1);

    // Cloning must NOT consume the source template — it stays installable in
    // Discover until the user publishes (the invariant the retired agent-e2e
    // flows owned: "template tile disappeared after clone — expected templates
    // to remain available until publish"). Adopt navigates to the new thread,
    // so return to Discover and assert the Daily Digest card is still listed.
    await gotoNav(launched.page, 'Discover');
    await expect(launched.page.getByRole('button', { name: /Daily Digest/ })).toBeVisible();

    const manifestPath = path.join(env.appsDir, 'digest-clone', 'app.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      id: string;
      name: string;
    };
    expect(manifest).toMatchObject({ id: 'digest-clone', name: 'Daily Digest' });

    await closeApp(launched.app);
    launched = undefined;
    await gateway.close();
    gateway = await startMockGateway({ appsDir: env.appsDir });
    await seedRemoteGateway(env, gateway);

    launched = await launchApp(env);
    await waitForHome(launched.page);
    await gotoNav(launched.page, 'Automations');
    await expect(launched.page.getByRole('button', { name: /Daily Digest/ })).toBeVisible();
    await expect(fs.access(manifestPath)).resolves.toBeUndefined();
  } finally {
    if (launched) await closeApp(launched.app);
  }
});

test('10.3 — independent builder drafts coexist on disk and survive a full Electron restart', async () => {
  const prompts = ['Track hydration', 'Plan daily todos', 'Keep a private journal'];
  let launched = await launchApp(env);
  try {
    for (const [index, prompt] of prompts.entries()) {
      await waitForHome(launched.page);
      const composer = launched.page.getByPlaceholder(/Describe an app you want/i);
      await composer.fill(prompt);
      await composer.press('Control+Enter');
      await expect.poll(() => gateway.state.apps.length, { timeout: 10_000 }).toBe(index + 1);
      await closeApp(launched.app);
      launched = await launchApp(env);
    }
    await waitForHome(launched.page);
    const draftIds = gateway.state.apps.map((entry) => entry.id).sort();
    const appDirectories = (await fs.readdir(env.appsDir)).sort();
    expect(appDirectories).toEqual(draftIds);
    for (const id of draftIds) {
      const manifest = JSON.parse(
        await fs.readFile(path.join(env.appsDir, id, 'app.json'), 'utf8'),
      ) as { id: string; name: string };
      expect(manifest.id).toBe(id);
      expect(manifest.name.length).toBeGreaterThan(0);
    }
    await closeApp(launched.app);

    const restarted = await launchApp(env);
    try {
      await waitForHome(restarted.page);
      for (const id of draftIds) {
        await expect(restarted.page.locator(`[data-app-id="${id}"]`)).toBeVisible();
        await expect(fs.access(path.join(env.appsDir, id, 'app.json'))).resolves.toBeUndefined();
      }
    } finally {
      await closeApp(restarted.app);
    }
  } finally {
    await closeApp(launched.app).catch(() => undefined);
  }
});

test('10.4 — empty Discover renders without cards', async () => {
  gateway.state.templates = [];
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoNav(page, 'Discover');
    await expect(page.getByText('Nothing to install yet.')).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

// ─────────────────────────── §11 Insights ───────────────────────────

test('11.1 — Insights renders the KPI cards', async () => {
  gateway.state.insights = {
    windowDays: 30,
    kpis: {
      totalTokens: 12345,
      quotaTokens: 100000,
      unpricedRuns: 0,
      totalCostUsd: 1.23,
      forecastCostUsd: 4.56,
      appsTouched: 3,
      generations: 7,
      retries: 1,
    },
    daily: [
      { date: '2024-05-01', tokens: 5000 },
      { date: '2024-05-02', tokens: 7345 },
    ],
    byAutomation: [{ name: 'Digest', tokens: 8000, costUsd: 0.8 }],
    byModel: [{ model: 'tier-deep', tokens: 12345, costUsd: 1.23 }],
    recent: [],
  };
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoNav(page, 'Insights');
    await expect(page.getByTestId('insights-kpis')).toBeVisible();
    await expect(page.getByTestId('insights-kpis')).toContainText('Generations');
  } finally {
    await closeApp(app);
  }
});
