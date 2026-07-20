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
      // loadConnection prefers sessionStorage over localStorage. Control
      // sessions without rememberDevice live in sessionStorage (web-state
      // saveConnection); writing only localStorage is ignored when a
      // partial session entry exists or is re-written on boot.
      sessionStorage.removeItem('centraid.web.v1.connection');
      sessionStorage.setItem(
        'centraid.web.v1.connection',
        JSON.stringify({
          baseUrl: apiUrl,
          label: 'Browser E2E',
          displayName: 'Web owner',
          avatarColor: '#6f5bf6',
          vaultId: vault,
          control: true,
        }),
      );
      localStorage.removeItem('centraid.web.v1.connection');
      localStorage.setItem(
        'centraid.web.v1.settings',
        JSON.stringify({ onboardingCompletedAt: new Date().toISOString() }),
      );
      // Home only renders *pinned* apps when the builder is off (issue #434):
      // unpinned code-store rows become drafts and drafts are hidden
      // (`builderEnabled ? drafts : NO_DRAFTS`). Seed a Home pin for the
      // e2e fixture the same way Discover install would.
      localStorage.setItem(
        'centraid.v1.home.userApps',
        JSON.stringify([
          {
            id: 'web-e2e',
            name: 'Web E2E App',
            desc: 'A browser-isolation fixture.',
            iconKey: 'Sparkle',
            color: '#6f5bf6',
            colorKey: 'violet',
          },
        ]),
      );
      localStorage.setItem('centraid.v1.home.userApps.vault', JSON.stringify(vault));
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
    await page.evaluate(
      () =>
        sessionStorage.getItem('centraid.web.v1.connection') ??
        localStorage.getItem('centraid.web.v1.connection'),
    ),
  ).not.toContain(ADMIN_TOKEN);

  const manifest = await page.request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBeTruthy();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);

  // Pinned Home tiles open the installed app iframe (title="app"), not the
  // builder preview (title="App preview"). Builder is off on web (#434), so
  // the old draft→Publish dance is not the product path anymore.
  await page.locator('[data-app-id="web-e2e"] [data-testid="app-tile"]').click();
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
