import { test, expect, type Page } from '@playwright/test';
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

/** §12 Settings, §13 Gateways / profiles, §14 cross-cutting. */

/**
 * Open Settings from the sidebar.
 *
 * Not `gotoNav(page, 'Settings')`: that helper matches the accessible name
 * EXACTLY, and the Settings row alone carries a trailing "live" status pill
 * (Sidebar.tsx:477-483), so its accessible name is "Settings live". Every other
 * sidebar row is bare, which is why only this spec needs the prefix match.
 */
// The shared `gotoNav` fixture matches accessible names exactly, but the
// Settings sidebar row carries a decorative <StatusPill>live</StatusPill>, so
// its real accessible name is "Settings live". This prefix-matching local
// helper works around that. Once the pill is marked aria-hidden
// (https://github.com/srikanth235/centraid/issues/473) this can collapse back
// to `gotoNav(page, 'Settings')`.
async function gotoSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Settings\b/ }).click();
}

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
    await gotoSettings(page);
    await page.getByTestId('settings-page').waitFor({ state: 'visible' });

    const before = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--accent'),
    );
    // Click an accent swatch that isn't the current one. The swatches are the
    // radios of the "Accent" radiogroup (SettingsAppearanceScreen.tsx:134-152);
    // index 2 is Violet, never the default (teal, appearance.ts:14).
    const swatches = page.getByRole('radiogroup', { name: 'Accent' }).getByRole('radio');
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
    await closeApp(app);
  }
});

test('12.5 — appearance choices persist across a reload', async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoSettings(page);
    await page.getByTestId('settings-page').waitFor({ state: 'visible' });
    await page.getByRole('radiogroup', { name: 'Accent' }).getByRole('radio').nth(3).click();
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
    await closeApp(app);
  }
});

test('12.6 — an explicit dark theme survives a full Electron restart', async () => {
  const launched = await launchApp(env);
  try {
    await waitForHome(launched.page);
    await gotoSettings(launched.page);
    await launched.page.getByTestId('settings-page').waitFor({ state: 'visible' });
    // The theme presets are the radios of the "Color theme" radiogroup
    // (SettingsAppearanceScreen.tsx:76-102); `dark` is also the shipped default
    // (appearance.ts:13-21), so pass through Centraid Light first — otherwise
    // "survives a restart" would be satisfied by the default alone.
    const themes = launched.page.getByRole('radiogroup', { name: 'Color theme' });
    await themes.getByRole('radio', { name: 'Centraid Light' }).click();
    await expect
      .poll(() => launched.page.evaluate(() => document.documentElement.dataset.theme))
      .toBe('light');
    await themes.getByRole('radio', { name: 'Centraid Dark' }).click();
    await expect
      .poll(() => launched.page.evaluate(() => document.documentElement.dataset.theme))
      .toBe('dark');
    await closeApp(launched.app);

    const restarted = await launchApp(env);
    try {
      await waitForHome(restarted.page);
      await expect
        .poll(() => restarted.page.evaluate(() => document.documentElement.dataset.theme))
        .toBe('dark');
    } finally {
      await closeApp(restarted.app);
    }
  } finally {
    await closeApp(launched.app);
  }
});

test('12.2 — "Match system" resolves the OS scheme to a theme and persists it', async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoSettings(page);
    await page.getByTestId('settings-page').waitFor({ state: 'visible' });

    await page.getByRole('button', { name: 'Match system' }).click();
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
    await closeApp(app);
  }
});

test('12.4 — the Agents (providers) settings page renders', async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoSettings(page);
    await page.getByTestId('settings-page').waitFor({ state: 'visible' });

    await page.getByTestId('settings-nav').getByRole('button', { name: 'Agents' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Agents');
    // Realigned: the exclusive "active agent" switch no longer exists. Per
    // SettingsProvidersScreen.tsx:103-113 the exclusive radio was retired by
    // per-subsystem runners and became the *default* lane of the Routing
    // table — so the page's primary control is now the "Default agent" select
    // (SettingsProvidersScreen.tsx:268).
    await expect(page.getByRole('combobox', { name: 'Default agent' })).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await closeApp(app);
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
    await closeApp(app);
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
    await closeApp(app);
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
    await closeApp(app);
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
    await closeApp(app);
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
    // `[data-sidebar]` is the shell chrome root (ShellFrame.tsx:165).
    await expect(page.locator('[data-sidebar]')).toBeVisible();
  } finally {
    await closeApp(app);
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
    await clickMenuItem(page, 'Edit with Centraid');
    await page.getByTestId('builder-body').waitFor({ state: 'visible' });

    gateway.state.forceStatus = 401; // every call now rejects with auth_required
    await page.getByTestId('builder-publish').click();
    await expect(page.getByTestId('builder-body')).toContainText(/token|Settings/i, {
      timeout: 15_000,
    });
  } finally {
    await closeApp(app);
  }
});

test('14.4 — Cmd+K opens the command palette', async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await page.keyboard.press('Meta+k');
    // The palette is a labelled dialog (PaletteScreen.tsx:140).
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
  } finally {
    await closeApp(app);
  }
});
