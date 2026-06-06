import { test, expect } from '@playwright/test';
import {
  appEntry,
  cleanupEnv,
  launchApp,
  makeEnv,
  markUserApp,
  openTileMenu,
  seedRemoteGateway,
  startMockGateway,
  waitForHome,
  type MockGateway,
  type TestEnv,
} from './fixtures';

/** §4 App creation, §5 App editing, §6 Builder tabs. */

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

const TURN_FRAMES = [
  { data: { type: 'assistant.start' }, delayMs: 20 },
  { data: { type: 'assistant.delta', delta: 'Scaffolding your app…' }, delayMs: 20 },
  {
    data: { type: 'tool.start', toolCallId: 'w1', toolName: 'write', args: { path: 'index.html' } },
    delayMs: 20,
  },
  { data: { type: 'tool.result', toolCallId: 'w1', toolName: 'write', ok: true }, delayMs: 20 },
  { data: { type: 'assistant.delta', delta: ' Done — preview is live.' }, delayMs: 20 },
  { data: { type: 'final', text: 'Done.' }, delayMs: 20 },
];

/** Open an existing published app in the builder (Edit with Centraid). */
async function openEditor(
  page: import('@playwright/test').Page,
  id: string,
  name: string,
): Promise<void> {
  await waitForHome(page);
  await markUserApp(page, { id, name });
  await page.reload();
  await waitForHome(page);
  await openTileMenu(page, id);
  await page.locator('.ctx-item', { hasText: 'Edit with Centraid' }).click();
  await page.locator('.builder-body').waitFor({ state: 'visible' });
}

// ─────────────────────────── §4 creation ───────────────────────────

test('4.1 + 4.2 — composer opens the builder and the initial turn streams a tool pill', async () => {
  gateway.state.turnFrames = TURN_FRAMES;
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await page.locator('.cd-composer-input').fill('A habit tracker');
    await page.locator('.cd-composer-input').press('Meta+Enter');

    await expect(page.locator('.builder-body')).toBeVisible();
    // The new-app scaffold posts to the apps collection.
    await expect
      .poll(() =>
        gateway.calls.some((c) => c.method === 'POST' && c.pathname === '/centraid/_apps'),
      )
      .toBe(true);
    // The streamed turn renders an assistant reply + a tool group pill.
    await expect(page.locator('.msg-ai-text', { hasText: 'preview is live' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('.tool-group').first()).toBeVisible({ timeout: 15_000 });
  } finally {
    await app.close();
  }
});

test('4.4 — Publish posts to the gateway and returns to home on success', async () => {
  const id = 'todoer';
  gateway.state.apps = [appEntry({ id, name: 'Todoer' })];
  const { app, page } = await launchApp(env);
  try {
    await openEditor(page, id, 'Todoer');
    await page.locator('.cd-tl-publish').click();
    await expect
      .poll(
        () =>
          gateway.calls.some(
            (c) => c.method === 'POST' && /\/centraid\/_apps\/.*\/publish$/.test(c.pathname),
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    // A successful publish lands the app on home (builder unmounts).
    await expect(page.locator('.cd-apps-grid')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.builder-body')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('4.5 — a failed Publish surfaces an error and does not claim success', async () => {
  const id = 'todoer';
  gateway.state.apps = [appEntry({ id, name: 'Todoer' })];
  gateway.state.publishStatus = 500;
  const { app, page } = await launchApp(env);
  try {
    await openEditor(page, id, 'Todoer');
    await page.locator('.cd-tl-publish').click();
    // The publish was attempted…
    await expect
      .poll(() => gateway.calls.some((c) => c.method === 'POST' && c.pathname.endsWith('/publish')))
      .toBe(true);
    // …and the chat surfaced a failure status (no "Published vN" success toast).
    await expect(page.locator('.chat-scroll')).toContainText(/could.?n.?t|fail|error/i, {
      timeout: 15_000,
    });
  } finally {
    await app.close();
  }
});

test('4.3 — the builder Preview tab mounts the draft iframe', async () => {
  const id = 'previewer';
  gateway.state.apps = [appEntry({ id, name: 'Previewer' })];
  const { app, page } = await launchApp(env);
  try {
    await openEditor(page, id, 'Previewer');
    // Preview is the default right-pane tab.
    await expect(page.locator('.right-pane-content iframe[data-centraid-app]')).toHaveCount(1, {
      timeout: 10_000,
    });
  } finally {
    await app.close();
  }
});

// ─────────────────────────── §5 editing ───────────────────────────

test('5.1 — Edit with Centraid opens the existing app in the builder', async () => {
  const id = 'journal';
  gateway.state.apps = [appEntry({ id, name: 'Journal' })];
  const { app, page } = await launchApp(env);
  try {
    await openEditor(page, id, 'Journal');
    await expect(page.locator('.builder-body')).toBeVisible();
    // The session for this app id was opened on the gateway.
    expect(
      gateway.calls.some((c) => c.method === 'POST' && c.pathname === '/centraid/_apps/_sessions'),
    ).toBe(true);
  } finally {
    await app.close();
  }
});

// ─────────────────────────── §6 builder tabs ───────────────────────────

test('6.1 + 6.2 — switching to the Code tab lists files and opens one in the editor', async () => {
  const id = 'journal';
  gateway.state.apps = [appEntry({ id, name: 'Journal' })];
  gateway.state.filesById[id] = [
    { path: 'index.html', content: '<h1>Journal</h1>' },
    { path: 'style.css', content: 'body { color: rebeccapurple; }' },
  ];
  const { app, page } = await launchApp(env);
  try {
    await openEditor(page, id, 'Journal');
    await page.locator('.mode-tab[aria-label="Code"]').click();
    await expect(page.locator('.code-tree-file', { hasText: 'index.html' })).toBeVisible({
      timeout: 10_000,
    });
    await page.locator('.code-tree-file', { hasText: 'index.html' }).click();
    await expect(page.locator('.code-edit-pre').first()).toContainText('Journal', {
      timeout: 10_000,
    });
  } finally {
    await app.close();
  }
});

test('6.4 — Cloud Database lists tables, browses rows, and paginates', async () => {
  const id = 'journal';
  gateway.state.apps = [appEntry({ id, name: 'Journal' })];
  gateway.state.schemaById[id] = {
    schemaVersion: 1,
    tables: [
      {
        name: 'entries',
        sql: 'CREATE TABLE entries (id INTEGER PRIMARY KEY, title TEXT)',
        columns: [
          { name: 'id', type: 'INTEGER', pk: true, notnull: true, dflt_value: null },
          { name: 'title', type: 'TEXT', pk: false, notnull: false, dflt_value: null },
        ],
      },
    ],
    indexes: [],
    views: [],
  };
  // 60 rows → two pages at the 50-row page size, so Next is enabled.
  gateway.state.tableRows.entries = {
    columns: ['id', 'title'],
    rows: Array.from({ length: 60 }, (_, i) => ({ id: i + 1, title: `Entry ${i + 1}` })),
  };
  const { app, page } = await launchApp(env);
  try {
    await openEditor(page, id, 'Journal');
    await page.locator('.mode-tab[aria-label="Cloud"]').click();
    await page.locator('.cloud-rail-item', { hasText: 'Database' }).click();

    // The table card renders; opening it kicks off the row browser.
    await page.locator('.cloud-table-card', { hasText: 'entries' }).click();
    await expect(page.locator('.cloud-rows-grid')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.cloud-rows-pager-label')).toContainText('1–50 of 60');

    // Page forward → offset advances, pager label shows the second page.
    await page.locator('.cloud-rows-pager-btn', { hasText: 'Next' }).click();
    await expect(page.locator('.cloud-rows-pager-label')).toContainText('51–60 of 60', {
      timeout: 10_000,
    });
    expect(
      gateway.calls.some(
        (c) =>
          c.method === 'GET' && /\/data\/entries/.test(c.pathname) && /offset=50/.test(c.search),
      ),
    ).toBe(true);
  } finally {
    await app.close();
  }
});

test('6.6 — Cloud Logs renders entries and filters by level + search', async () => {
  const id = 'journal';
  gateway.state.apps = [appEntry({ id, name: 'Journal' })];
  gateway.state.logsById[id] = [
    {
      ts: 1_700_000_000_000,
      level: 'info',
      msg: 'started up cleanly',
      source: 'action',
      handler: 'boot',
    },
    {
      ts: 1_700_000_001_000,
      level: 'error',
      msg: 'kaboom while saving',
      source: 'query',
      handler: 'save',
    },
  ];
  const { app, page } = await launchApp(env);
  try {
    await openEditor(page, id, 'Journal');
    await page.locator('.mode-tab[aria-label="Cloud"]').click();
    await page.locator('.cloud-rail-item', { hasText: 'Logs' }).click();

    // Both lines show initially.
    await expect(page.locator('.cloud-logs-row')).toHaveCount(2, { timeout: 10_000 });

    // Filter to errors only → the info line drops out.
    await page.locator('.cloud-logs-chip[data-level="error"]').click();
    await expect(page.locator('.cloud-logs-row')).toHaveCount(1);
    await expect(page.locator('.cloud-logs-row')).toContainText('kaboom');

    // Back to All, then narrow by free-text search.
    await page.locator('.cloud-logs-chip[data-level="all"]').click();
    await page.locator('.cloud-logs-search').fill('cleanly');
    await expect(page.locator('.cloud-logs-row')).toHaveCount(1);
    await expect(page.locator('.cloud-logs-row')).toContainText('started up');
  } finally {
    await app.close();
  }
});

test('6.5 — Cloud SQL runs a query and shows output', async () => {
  const id = 'journal';
  gateway.state.apps = [appEntry({ id, name: 'Journal' })];
  gateway.state.schemaById[id] = {
    tables: [{ name: 'entries', columns: [{ name: 'id', type: 'INTEGER' }] }],
  };
  gateway.state.queryResult = { kind: 'rows', columns: ['n'], rows: [{ n: 42 }], durationMs: 3 };
  const { app, page } = await launchApp(env);
  try {
    await openEditor(page, id, 'Journal');
    await page.locator('.mode-tab[aria-label="Cloud"]').click();
    await page.locator('.cloud-rail-item', { hasText: 'SQL' }).click();
    await page.locator('.cloud-sql-textarea').fill('SELECT 42 AS n');
    await page.locator('.cloud-sql-run-btn').click();
    await expect(page.locator('.cloud-sql-output')).toContainText('42', { timeout: 10_000 });
    expect(
      gateway.calls.some(
        (c) => c.method === 'POST' && /\/centraid\/_apps\/.*\/query$/.test(c.pathname),
      ),
    ).toBe(true);
  } finally {
    await app.close();
  }
});
