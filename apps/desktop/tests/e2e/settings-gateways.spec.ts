import { test, expect } from '@playwright/test';
import {
  appEntry,
  cleanupEnv,
  gotoNav,
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

/** §12 Settings, §13 Gateways / profiles, §14 cross-cutting. */

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

// ─────────────────────────── §12 Settings ───────────────────────────

test('12.1 — picking an accent in Appearance applies it live and saves to the gateway', async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoNav(page, 'Settings');
    await page.locator('.cd-settings-page').first().waitFor({ state: 'visible' });

    const before = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--accent'),
    );
    // Click an accent swatch that isn't the current one.
    const swatches = page.locator('.cd-swatch');
    await swatches.nth(2).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--accent')))
      .not.toBe(before);
    // The change is persisted to the gateway prefs store.
    await expect
      .poll(() =>
        gateway.calls.some((c) => c.method === 'PUT' && c.pathname === '/_centraid-user/prefs'),
      )
      .toBe(true);
  } finally {
    await app.close();
  }
});

test('12.5 — appearance choices persist across a reload', async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoNav(page, 'Settings');
    await page.locator('.cd-swatch').nth(3).click();
    const accent = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--accent'),
    );
    await page.reload();
    await waitForHome(page);
    const after = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--accent'),
    );
    expect(after).toBe(accent);
  } finally {
    await app.close();
  }
});

test('12.2 — "Match system" resolves the OS scheme to a theme and persists it', async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoNav(page, 'Settings');
    await page.locator('.cd-settings-page').first().waitFor({ state: 'visible' });

    await page.locator('.cd-link-btn', { hasText: 'Match system' }).click();
    // A concrete theme is applied to the document root…
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toMatch(/^(light|dark)$/);
    // …and the choice is mirrored to the gateway prefs store with a theme key.
    await expect
      .poll(() =>
        gateway.calls.some(
          (c) =>
            c.method === 'PUT' &&
            c.pathname === '/_centraid-user/prefs' &&
            /"theme"/.test(c.body ?? ''),
        ),
      )
      .toBe(true);
  } finally {
    await app.close();
  }
});

test('12.4 — the Agents (providers) settings page renders', async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoNav(page, 'Settings');
    await page.locator('.cd-settings-page').first().waitFor({ state: 'visible' });

    await page.locator('.cd-settings-nav-item', { hasText: 'Agents' }).click();
    await expect(page.locator('.cd-settings-page-title')).toHaveText('Agents');
    // The active-agent switch is the page's primary control.
    await expect(page.locator('.agent-switch')).toBeVisible({ timeout: 10_000 });
  } finally {
    await app.close();
  }
});

// ─────────────────────────── §13 Gateways / profiles ───────────────────────────

test('13.2 — adding a remote gateway registers it in the store', async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    const before = await page.evaluate(() =>
      window.CentraidApi.listGateways().then((g) => g.length),
    );
    await page.evaluate(
      (url) => window.CentraidApi.addGateway({ label: 'Staging', url, token: '' }),
      gateway.url,
    );
    const after = await page.evaluate(() => window.CentraidApi.listGateways());
    expect((after as unknown[]).length).toBe(before + 1);
    expect((after as Array<{ label: string }>).some((g) => g.label === 'Staging')).toBe(true);
  } finally {
    await app.close();
  }
});

test('13.4 — switching the active gateway re-scopes home', async () => {
  // A second gateway pointing at the same mock, so its app list resolves.
  gateway.state.apps = [appEntry({ id: 'shared', name: 'Shared App' })];
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    const newId = (await page.evaluate(
      (url) => window.CentraidApi.addGateway({ label: 'Second', url, token: '' }).then((g) => g.id),
      gateway.url,
    )) as string;

    const callsBefore = gateway.calls.length;
    await page.evaluate((id) => window.CentraidApi.setActiveGateway({ id }), newId);

    // Active pointer flipped and the renderer re-fetched against the gateway.
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.CentraidApi.getSettings().then(
            (s) => (s as { activeGatewayId: string }).activeGatewayId,
          ),
        ),
      )
      .toBe(newId);
    await expect.poll(() => gateway.calls.length).toBeGreaterThan(callsBefore);
    await waitForHome(page);
  } finally {
    await app.close();
  }
});

test('13.7 — a remote gateway can be removed; the local one cannot', async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    const id = (await page.evaluate(
      (url) => window.CentraidApi.addGateway({ label: 'Temp', url, token: '' }).then((g) => g.id),
      gateway.url,
    )) as string;
    await page.evaluate((gid) => window.CentraidApi.removeGateway({ id: gid }), id);
    const list = (await page.evaluate(() => window.CentraidApi.listGateways())) as Array<{
      id: string;
    }>;
    expect(list.some((g) => g.id === id)).toBe(false);

    // Removing the primordial local gateway is rejected.
    const localErr = await page.evaluate(() =>
      window.CentraidApi.removeGateway({ id: 'local' })
        .then(() => null)
        .catch((e: Error) => String(e.message ?? e)),
    );
    expect(localErr).toBeTruthy();
  } finally {
    await app.close();
  }
});

test('13.3 — a local workspace can be added', async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    const added = (await page.evaluate(() =>
      window.CentraidApi.addLocalGateway({ label: 'Scratch' }),
    )) as { id: string; kind: string };
    expect(added.kind).toBe('local');
    const list = (await page.evaluate(() => window.CentraidApi.listGateways())) as Array<{
      label: string;
    }>;
    expect(list.some((g) => g.label === 'Scratch')).toBe(true);
  } finally {
    await app.close();
  }
});

test('13.5 + 13.6 — a remote gateway can be renamed and have its token rotated', async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    const id = (await page.evaluate(
      (url) =>
        window.CentraidApi.addGateway({ label: 'Old Label', url, token: '' }).then((g) => g.id),
      gateway.url,
    )) as string;

    await page.evaluate(
      (gid) => window.CentraidApi.renameGateway({ id: gid, label: 'New Label' }),
      id,
    );
    const list = (await page.evaluate(() => window.CentraidApi.listGateways())) as Array<{
      id: string;
      label: string;
    }>;
    expect(list.find((g) => g.id === id)?.label).toBe('New Label');

    // Rotating the token round-trips through the keychain without error.
    const rotateErr = await page.evaluate(
      (gid) =>
        window.CentraidApi.updateGatewayToken({ id: gid, token: 'rotated-secret' })
          .then(() => null)
          .catch((e: Error) => String(e?.message ?? e)),
      id,
    );
    expect(rotateErr).toBeNull();
  } finally {
    await app.close();
  }
});

test('13.8 — switching to an unreachable gateway degrades gracefully', async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    const deadId = (await page.evaluate(() =>
      window.CentraidApi.addGateway({ label: 'Dead', url: 'http://127.0.0.1:1', token: '' }).then(
        (g) => g.id,
      ),
    )) as string;
    await page.evaluate((id) => window.CentraidApi.setActiveGateway({ id }), deadId);
    // No crash — the shell stays mounted even though the gateway is unreachable.
    await expect(page.locator('.cd-window')).toBeVisible();
  } finally {
    await app.close();
  }
});

// ─────────────────────────── §14 cross-cutting ───────────────────────────

test('14.2 — an auth failure on publish surfaces a token/Settings prompt', async () => {
  const id = 'todoer';
  gateway.state.apps = [appEntry({ id, name: 'Todoer' })];
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await markUserApp(page, { id, name: 'Todoer' });
    await page.reload();
    await waitForHome(page);
    await openTileMenu(page, id);
    await page.locator('.ctx-item', { hasText: 'Edit with Centraid' }).click();
    await page.locator('.builder-body').waitFor({ state: 'visible' });

    gateway.state.forceStatus = 401; // every call now rejects with auth_required
    await page.locator('.cd-tl-publish').click();
    await expect(page.locator('.builder-body')).toContainText(/token|Settings/i, {
      timeout: 15_000,
    });
  } finally {
    await app.close();
  }
});

test('14.4 — Cmd+K opens the command palette', async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await page.keyboard.press('Meta+k');
    await expect(page.locator('.cd-palette')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.cd-palette')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
