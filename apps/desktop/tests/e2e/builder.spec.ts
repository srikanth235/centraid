import { test, expect } from '@playwright/test';
import {
  appEntry,
  cleanupEnv,
  clickMenuItem,
  closeApp,
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
  await clickMenuItem(page, 'Edit with Centraid');
  await page.getByTestId('builder-body').waitFor({ state: 'visible' });
}

// ─────────────────────────── §4 creation ───────────────────────────

test('4.1 + 4.2 — composer opens the builder and the initial turn streams a tool pill', async () => {
  gateway.state.turnFrames = TURN_FRAMES;
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await page.getByTestId('home-composer').fill('A habit tracker');
    await page.getByTestId('home-composer').press('Meta+Enter');

    await expect(page.getByTestId('builder-body')).toBeVisible();
    // The new-app scaffold posts to the apps collection.
    await expect
      .poll(() =>
        gateway.calls.some((c) => c.method === 'POST' && c.pathname === '/centraid/_apps'),
      )
      .toBe(true);
    // The streamed turn renders an assistant reply + a tool group pill.
    await expect(
      page.getByTestId('builder-ai-text').filter({ hasText: 'preview is live' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('tool-group').first()).toBeVisible({ timeout: 15_000 });
  } finally {
    await closeApp(app);
  }
});

// SKIPPED — open product question, tracked in
// https://github.com/srikanth235/centraid/issues/471.
// #496 P8 / matrix note builder.publish — builder is not in v0 (hidden surface).
// Declared skip with product reason; not a fake solid journey. Do not revive
// until builder is in-scope for the product.
test.skip('4.4 — Publish posts to the gateway and returns to home on success', async () => {
  const id = 'todoer';
  gateway.state.apps = [appEntry({ id, name: 'Todoer' })];
  const { app, page } = await launchApp(env);
  try {
    await openEditor(page, id, 'Todoer');
    await page.getByTestId('builder-publish').click();
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
    await expect(page.getByTestId('apps-grid')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('builder-body')).toHaveCount(0);
  } finally {
    await closeApp(app);
  }
});

test('4.5 — a failed Publish surfaces an error and does not claim success', async () => {
  const id = 'todoer';
  gateway.state.apps = [appEntry({ id, name: 'Todoer' })];
  gateway.state.publishStatus = 500;
  const { app, page } = await launchApp(env);
  try {
    await openEditor(page, id, 'Todoer');
    await page.getByTestId('builder-publish').click();
    // The publish was attempted…
    await expect
      .poll(() => gateway.calls.some((c) => c.method === 'POST' && c.pathname.endsWith('/publish')))
      .toBe(true);
    // …and the chat surfaced a failure status (no "Published vN" success toast).
    await expect(page.getByTestId('builder-chat-scroll')).toContainText(/could.?n.?t|fail|error/i, {
      timeout: 15_000,
    });
  } finally {
    await closeApp(app);
  }
});

test('4.3 — the builder Preview tab mounts the draft iframe', async () => {
  const id = 'previewer';
  gateway.state.apps = [appEntry({ id, name: 'Previewer' })];
  const { app, page } = await launchApp(env);
  try {
    await openEditor(page, id, 'Previewer');
    // Preview is the default right-pane tab.
    await expect(
      page.getByTestId('builder-right-pane').locator('iframe[data-centraid-app]'),
    ).toHaveCount(1, {
      timeout: 10_000,
    });
  } finally {
    await closeApp(app);
  }
});

// ─────────────────────────── §5 editing ───────────────────────────

test('5.1 — Edit with Centraid opens the existing app in the builder', async () => {
  const id = 'journal';
  gateway.state.apps = [appEntry({ id, name: 'Journal' })];
  const { app, page } = await launchApp(env);
  try {
    await openEditor(page, id, 'Journal');
    await expect(page.getByTestId('builder-body')).toBeVisible();
    // The session for this app id was opened on the gateway.
    expect(
      gateway.calls.some((c) => c.method === 'POST' && c.pathname === '/centraid/_apps/_sessions'),
    ).toBe(true);
  } finally {
    await closeApp(app);
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
    await page.getByRole('button', { name: 'Code', exact: true }).click();
    await expect(page.locator('.code-tree-file', { hasText: 'index.html' })).toBeVisible({
      timeout: 10_000,
    });
    await page.locator('.code-tree-file', { hasText: 'index.html' }).click();
    await expect(page.getByTestId('code-edit-pre').first()).toContainText('Journal', {
      timeout: 10_000,
    });
  } finally {
    await closeApp(app);
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
    await page.getByRole('button', { name: 'Cloud', exact: true }).click();
    await page.getByTestId('cloud-rail-item').filter({ hasText: 'Logs' }).click();

    // Both lines show initially.
    await expect(page.getByTestId('cloud-logs-row')).toHaveCount(2, { timeout: 10_000 });

    // Filter to errors only → the info line drops out.
    await page
      .getByTestId('cloud-logs-chip')
      .filter({ hasText: /^Error/i })
      .click();
    await expect(page.getByTestId('cloud-logs-row')).toHaveCount(1);
    await expect(page.getByTestId('cloud-logs-row')).toContainText('kaboom');

    // Back to All, then narrow by free-text search.
    await page.getByTestId('cloud-logs-chip').filter({ hasText: /^All$/i }).click();
    await page.getByTestId('cloud-logs-search').fill('cleanly');
    await expect(page.getByTestId('cloud-logs-row')).toHaveCount(1);
    await expect(page.getByTestId('cloud-logs-row')).toContainText('started up');
  } finally {
    await closeApp(app);
  }
});
