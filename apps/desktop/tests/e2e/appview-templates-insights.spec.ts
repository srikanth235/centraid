import { test, expect } from '@playwright/test';
import {
  appEntry,
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
  gateway = await startMockGateway();
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
  await page.locator('.app-view').waitFor({ state: 'visible' });
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
    await expect(page.locator('.cd-apps-grid')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('7.2 — the chat FAB opens the copilot panel', async () => {
  gateway.state.apps = [appEntry({ id: 'notes', name: 'Notes' })];
  const { app, page } = await launchApp(env);
  try {
    await openApp(page, 'notes', 'Notes');
    await page.locator('.app-chat-fab').click();
    await expect(page.locator('.app-chat-panel.open')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('7.3 — a chat turn streams an assistant reply and a SQL tool result', async () => {
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
    await app.close();
  }
});

test('7.4 — the copilot past-chats history lists prior sessions and filters by search', async () => {
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
    await app.close();
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
    await expect(page.locator('.cd-disc-card')).toHaveCount(2);
    await expect(page.locator('.cd-disc-card-name', { hasText: 'Habit Tracker' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('10.2 — using a template clones it and opens the builder', async () => {
  gateway.state.templates = [
    {
      id: 'habit',
      name: 'Habit Tracker',
      desc: 'Track habits',
      colorKey: 'violet',
      iconKey: 'Todo',
      version: '1',
    },
  ];
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoNav(page, 'Discover');
    await page.locator('.cd-disc-card', { hasText: 'Habit Tracker' }).click();
    await page.locator('.cd-tmpl-preview .btn-primary', { hasText: 'Use this template' }).click();
    await expect(page.locator('.builder-body')).toBeVisible({ timeout: 10_000 });
    expect(
      gateway.calls.some((c) => c.method === 'POST' && c.pathname === '/centraid/_apps/_clone'),
    ).toBe(true);
  } finally {
    await app.close();
  }
});

test('10.4 — empty Discover renders without cards', async () => {
  gateway.state.templates = [];
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoNav(page, 'Discover');
    await page.locator('.cd-disc-cats, .cd-disc-head').first().waitFor({ state: 'visible' });
    await expect(page.locator('.cd-disc-card')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

// ─────────────────────────── §11 Insights ───────────────────────────

test('11.1 — Insights renders the KPI cards', async () => {
  gateway.state.insights = {
    windowDays: 30,
    vault: { id: 'v1', name: 'Home' },
    kpis: {
      totalTokens: 12345,
      cacheReadTokens: 4000,
      totalCostUsd: 1.23,
      forecastCostUsd: 4.56,
      appsTouched: 3,
      generations: 7,
      retries: 1,
      unpricedRuns: 1,
      unpricedTokens: 500,
    },
    daily: [
      { date: '2024-05-01', tokens: 5000, costUsd: 0.5, runs: 3 },
      { date: '2024-05-02', tokens: 7345, costUsd: 0.73, runs: 4 },
    ],
    byAutomation: [
      {
        key: 'auto.digest/daily',
        label: 'Digest',
        kind: 'automation',
        runs: 4,
        tokens: 8000,
        costUsd: 0.8,
      },
    ],
    byModel: [{ model: 'tier-deep', runs: 7, tokens: 12345, costUsd: 1.23 }],
    recent: [],
  };
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoNav(page, 'Insights');
    await expect(page.locator('.cd-ins-kpis')).toBeVisible();
    await expect(page.locator('.cd-ins-kpis')).toContainText('Generations');
    // The spend card is honest about being an estimate, not a bill.
    await expect(page.locator('.cd-ins-kpis')).toContainText('est. USD');
    // The scoped vault is named in the header (#289).
    await expect(page.locator('.cd-ins-vault')).toContainText('Home');
  } finally {
    await app.close();
  }
});
