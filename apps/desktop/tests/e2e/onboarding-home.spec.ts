import { test, expect } from '@playwright/test';
import {
  appEntry,
  cleanupEnv,
  gotoNav,
  launchApp,
  makeEnv,
  markUserApp,
  openTile,
  openTileMenu,
  seedRemoteGateway,
  startMockGateway,
  waitForHome,
  type MockGateway,
  type TestEnv,
} from './fixtures';

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

test('1.1 — first launch shows onboarding with the CTA disabled until a name is entered', async () => {
  await seedRemoteGateway(env, gateway, { onboarding: true });
  const { app, page } = await launchApp(env);
  try {
    await page.locator('.cd-onb-view').waitFor({ state: 'visible' });
    const cta = page.locator('.cd-onb-cta');
    await expect(cta).toBeDisabled();
    await page.locator('.cd-onb-input').fill('Ada Lovelace');
    await expect(cta).toBeEnabled();
    // Clearing the name disables it again.
    await page.locator('.cd-onb-input').fill('');
    await expect(cta).toBeDisabled();
  } finally {
    await app.close();
  }
});

test('1.2 — completing onboarding persists the profile and lands on home', async () => {
  await seedRemoteGateway(env, gateway, { onboarding: true });
  gateway.state.apps = [];
  const { app, page } = await launchApp(env);
  try {
    await page.locator('.cd-onb-view').waitFor({ state: 'visible' });
    await page.locator('.cd-onb-input').fill('Ada Lovelace');
    // Pick a specific swatch.
    await page.locator('.cd-onb-swatch').nth(2).click();
    await page.locator('.cd-onb-cta').click();

    // Onboarding view gone, home shell present.
    await page.locator('.cd-onb-view').waitFor({ state: 'detached' });
    await waitForHome(page);
    // Persisted flag means a relaunch would skip onboarding.
    const persisted = await page.evaluate(() => window.CentraidApi.getSettings());
    expect((persisted as { onboardingCompletedAt?: string }).onboardingCompletedAt).toBeTruthy();
  } finally {
    await app.close();
  }
});

test('1.4 — a returning user (onboarding already complete) boots straight to home', async () => {
  await seedRemoteGateway(env, gateway); // onboarding complete by default
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await expect(page.locator('.cd-onb-view')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

// ─────────────────────────── §2 Home / tiles ───────────────────────────

test('2.1 — home renders tiles with the right badges (draft vs new)', async () => {
  gateway.state.apps = [
    appEntry({ id: 'published-old', name: 'Established' }),
    appEntry({ id: 'a-draft', name: 'A Draft' }),
  ];
  await seedRemoteGateway(env, gateway);
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    // Adopt one app into userApps (recent) → "new" badge; reload to reclassify.
    await markUserApp(page, { id: 'published-old', name: 'Established' });
    await page.reload();
    await waitForHome(page);

    // The unadopted gateway app is a draft.
    await expect(
      page.locator('[data-app-id="a-draft"] .cd-status[data-tone="draft"]'),
    ).toBeVisible();
    // The adopted, freshly-created app shows the "new" badge.
    await expect(
      page.locator('[data-app-id="published-old"] .cd-status[data-tone="new"]'),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test('2.2 — empty state renders the shelf-empty card with the composer still present', async () => {
  gateway.state.apps = [];
  await seedRemoteGateway(env, gateway);
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await expect(page.locator('.cd-composer-input')).toBeVisible();
    await expect(page.locator('.cd-shelf-empty', { hasText: 'No apps yet' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('2.3 — renaming a tile via the context menu patches meta and shows a toast', async () => {
  const id = 'rename-me';
  gateway.state.apps = [appEntry({ id, name: 'Old Name' })];
  await seedRemoteGateway(env, gateway);
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await markUserApp(page, { id, name: 'Old Name' });
    await page.reload();
    await waitForHome(page);

    await openTileMenu(page, id);
    await page.locator('.ctx-item', { hasText: 'Rename' }).click();
    // Inline editable name field becomes focused; type a new name + Enter.
    const nameEl = page.locator(`[data-app-id="${id}"] .cd-app-card-name`);
    await nameEl.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('New Name');
    await page.keyboard.press('Enter');

    await expect(page.locator('.global-toast')).toContainText(/Renamed/i);
    // The meta POST went to the gateway.
    expect(
      gateway.calls.some(
        (c) => c.method === 'POST' && /\/centraid\/_apps\/.*\/meta$/.test(c.pathname),
      ),
    ).toBe(true);
  } finally {
    await app.close();
  }
});

test('2.5 — the tile context menu exposes Open / Edit / Rename / Share / Reveal / Delete', async () => {
  const id = 'menu-app';
  gateway.state.apps = [appEntry({ id, name: 'Menu App' })];
  await seedRemoteGateway(env, gateway);
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await markUserApp(page, { id, name: 'Menu App' });
    await page.reload();
    await waitForHome(page);
    await openTileMenu(page, id);
    const items = page.locator('.ctx-menu .ctx-item');
    await expect(items).toContainText([
      'Open',
      'Edit with Centraid',
      'Rename',
      'Share',
      'Reveal in Finder',
      'Delete',
    ]);
  } finally {
    await app.close();
  }
});

test('2.6 — clicking a tile opens the app view iframe', async () => {
  const id = 'open-me';
  gateway.state.apps = [appEntry({ id, name: 'Open Me' })];
  await seedRemoteGateway(env, gateway);
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await markUserApp(page, { id, name: 'Open Me' });
    await page.reload();
    await waitForHome(page);
    await openTile(page, id);
    await expect(page.locator('.app-view')).toBeVisible();
    await expect(page.locator('iframe[data-centraid-app]')).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test('2.7 — the sidebar toggle flips the window sidebar state', async () => {
  gateway.state.apps = [];
  await seedRemoteGateway(env, gateway);
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    const win = page.locator('.cd-window');
    await expect(win).toHaveAttribute('data-sidebar', 'open');
    await page.locator('button[aria-label="Hide sidebar"]').first().click();
    await expect(win).toHaveAttribute('data-sidebar', 'closed');
    await page.locator('button[aria-label="Show sidebar"]').first().click();
    await expect(win).toHaveAttribute('data-sidebar', 'open');
  } finally {
    await app.close();
  }
});

test('2.8 — the command palette opens from the sidebar Search item', async () => {
  gateway.state.apps = [];
  await seedRemoteGateway(env, gateway);
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoNav(page, 'Search');
    await expect(page.locator('.cd-palette')).toBeVisible();
    await expect(page.locator('.cd-palette-input')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.cd-palette')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
