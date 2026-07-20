import { expect, test } from '@playwright/test';

const API_URL = 'http://127.0.0.1:48765';
const ADMIN_TOKEN = 'centraid-web-e2e-token';

test('boots as a PWA, establishes a cookie control session, and runs an isolated app', async ({
  page,
}) => {
  const gatewayResponses: Array<{ url: string; status: number }> = [];
  page.on('response', (response) => {
    if (response.url().startsWith(API_URL)) {
      gatewayResponses.push({ url: response.url(), status: response.status() });
    }
  });
  await page.goto('/');

  const control = await page.evaluate(
    async ({ apiUrl, token }) => {
      const response = await fetch(`${apiUrl}/centraid/_web/control`, {
        method: 'POST',
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}` },
      });
      return { status: response.status, body: await response.json() };
    },
    { apiUrl: API_URL, token: ADMIN_TOKEN },
  );
  expect(control.status).toBe(200);
  const vaultId = (control.body as { vaultId: string }).vaultId;
  const controlCookie = (await page.context().cookies(`${API_URL}/centraid/_web/control`)).find(
    (cookie) => cookie.name === '__centraid_control',
  );
  expect(controlCookie).toMatchObject({ httpOnly: true, sameSite: 'Strict' });

  await page.evaluate(
    ({ apiUrl, vault }) => {
      // `loadConnection` reads sessionStorage BEFORE localStorage, and the
      // boot-time /web-config.json bootstrap in main.ts writes a baseUrl-only
      // record there (rememberDevice defaults false). Drop it, or it shadows
      // this one across the reload and `vaultId`/`control` never land.
      sessionStorage.removeItem('centraid.web.v1.connection');
      localStorage.setItem(
        'centraid.web.v1.connection',
        JSON.stringify({
          baseUrl: apiUrl,
          label: 'Browser E2E',
          displayName: 'Web owner',
          avatarColor: '#6f5bf6',
          vaultId: vault,
          control: true,
          rememberDevice: true,
        }),
      );
      // The fixture app is published to the app store but never *installed*
      // (no Home pin), so the shell classifies it as a DRAFT — and drafts,
      // the builder preview, and Publish are all gated behind the
      // `builderEnabled` dev flag (issue #434, default false). This flow
      // exercises exactly those builder surfaces, so opt the harness in.
      localStorage.setItem(
        'centraid.web.v1.settings',
        JSON.stringify({
          onboardingCompletedAt: new Date().toISOString(),
          builderEnabled: true,
        }),
      );
    },
    { apiUrl: API_URL, vault: vaultId },
  );
  await page.reload();

  await expect(page.evaluate(() => window.CentraidApi.getGatewayAuth())).resolves.toMatchObject({
    baseUrl: API_URL,
    vaultId,
    webControl: true,
  });

  const appsProbe = await page.evaluate(async (apiUrl) => {
    const response = await fetch(
      `${apiUrl}/centraid/_web/control?path=${encodeURIComponent('/centraid/_apps')}`,
      { credentials: 'include' },
    );
    return { status: response.status, text: await response.text() };
  }, API_URL);
  expect(appsProbe.status, appsProbe.text).toBe(200);
  expect(appsProbe.text).toContain('web-e2e');

  await expect(
    page.locator('[data-app-id="web-e2e"]'),
    JSON.stringify(gatewayResponses, null, 2),
  ).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem('centraid.web.v1.connection')),
  ).not.toContain(ADMIN_TOKEN);

  const manifest = await page.request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBeTruthy();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);

  await page.locator('[data-app-id="web-e2e"] [data-testid="app-tile"]').click();
  const preview = page.frameLocator('iframe[title="App preview"]');
  await expect(preview.getByRole('heading', { name: 'Web E2E App' })).toBeVisible();
  await expect(preview.locator('#ready')).toHaveText('generated app ready');

  const previewPing = await preview.locator('body').evaluate(async () => {
    return window.centraid.read({ query: 'ping', input: {} });
  });
  expect(previewPing).toEqual({ pong: true, surface: 'web' });

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Already up to date — added to Home.')).toBeVisible();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.locator('[data-app-id="web-e2e"]').first()).toBeVisible();
  await page.locator('[data-app-id="web-e2e"] [data-testid="app-tile"]').first().click();
  const app = page.frameLocator('iframe[title="app"]');
  await expect(app.getByRole('heading', { name: 'Web E2E App' })).toBeVisible();
  await expect(app.locator('#ready')).toHaveText('generated app ready');

  const ping = await app.locator('body').evaluate(async () => {
    return window.centraid.read({ query: 'ping', input: {} });
  });
  expect(ping).toEqual({ pong: true, surface: 'web' });

  const frame = page.frames().find((candidate) => candidate.url().includes('/centraid/web-e2e/'))!;
  const confinement = await frame.evaluate(async () => {
    const [apps, control] = await Promise.all([
      fetch('/centraid/_apps'),
      fetch('/centraid/_web/control?path=%2Fcentraid%2F_apps', { credentials: 'include' }),
    ]);
    return { apps: apps.status, control: control.status };
  });
  expect(confinement).toEqual({ apps: 401, control: 401 });
});
