import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  appEntry,
  cleanupEnv,
  clickMenuItem,
  closeApp,
  confirmDelete,
  expectConfirm,
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

/**
 * §3 — App deletion. Post-#137/#141 the app's code lives in the gateway git
 * store, so deletion goes over HTTP:
 *   - a DRAFT (a gateway app not yet adopted into localStorage userApps) is
 *     removed with a single `DELETE /centraid/_apps/:id`.
 *   - a PUBLISHED app fires deregister + a best-effort session delete (two
 *     DELETEs), then drops the local userApps entry.
 */

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

const deletes = (g: MockGateway, id?: string) =>
  g.calls.filter(
    (c) =>
      c.method === 'DELETE' &&
      c.pathname.startsWith('/centraid/_apps/') &&
      (!id || c.pathname.endsWith(id)),
  );

// ---------- 3.1 draft delete ----------

test('3.1 — deleting a draft removes it via the gateway', async () => {
  gateway.state.apps = [appEntry({ id: 'draft-grocery', name: 'Grocery list' })];
  const draftDir = path.join(env.appsDir, 'draft-grocery');
  await fs.mkdir(draftDir, { recursive: true });
  await fs.writeFile(
    path.join(draftDir, 'app.json'),
    `${JSON.stringify({ id: 'draft-grocery', name: 'Grocery list' })}\n`,
  );
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    // Not in userApps → classed as a draft.
    await openTileMenu(page, 'draft-grocery');
    await clickMenuItem(page, 'Delete draft');
    await expectConfirm(page, 'Delete draft?');
    await confirmDelete(page);

    await expect(page.locator('[data-app-id="draft-grocery"]')).toHaveCount(0);
    await expect(page.locator('[data-global-toast]')).toContainText('Deleted draft');
    expect(deletes(gateway, 'draft-grocery').length).toBeGreaterThanOrEqual(1);
    await expect(fs.access(draftDir)).rejects.toThrow();

    await closeApp(app);
    const restarted = await launchApp(env);
    try {
      await waitForHome(restarted.page);
      await expect(restarted.page.locator('[data-app-id="draft-grocery"]')).toHaveCount(0);
      await expect(fs.access(draftDir)).rejects.toThrow();
    } finally {
      await closeApp(restarted.app);
    }
  } finally {
    await closeApp(app);
  }
});

// ---------- 3.2 published delete (gateway reachable) ----------

test('3.2 — deleting a published app deregisters on the gateway and clears local state', async () => {
  const id = 'todo-abc123';
  gateway.state.apps = [appEntry({ id, name: 'My Todos' })];
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await markUserApp(page, { id, name: 'My Todos' });
    await page.reload();
    await waitForHome(page);

    await openTileMenu(page, id);
    await clickMenuItem(page, 'Delete');
    await expectConfirm(page, 'Delete app?');
    await confirmDelete(page);

    await expect(page.locator(`[data-app-id="${id}"]`)).toHaveCount(0);
    // Realigned: the success toast reads `Deleted "<name>"` (it used to say
    // "Removed"). See HomeRoute.tsx:148 (`showToast(\`Deleted ${draft ? 'draft ' : ''}"${app.name}"\`)`).
    await expect(page.locator('[data-global-toast]')).toContainText('Deleted "My Todos"');

    expect(deletes(gateway, id).length).toBeGreaterThanOrEqual(1);
    const stored = await page.evaluate(
      () => localStorage.getItem('centraid.v1.home.userApps') ?? '[]',
    );
    expect(JSON.parse(stored)).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

// ---------- 3.3 gateway offline ----------

test('3.3 — gateway offline: surfaces an error and keeps the tile', async () => {
  const id = 'habit-xyz';
  gateway.state.apps = [appEntry({ id, name: 'Daily Habits' })];
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await markUserApp(page, { id, name: 'Daily Habits' });
    await page.reload();
    await waitForHome(page);

    await gateway.close(); // unreachable

    await openTileMenu(page, id);
    await clickMenuItem(page, 'Delete');
    await expectConfirm(page, 'Delete app?');
    await confirmDelete(page);

    await expect(page.locator('[data-global-toast]')).toContainText(/Could not delete.*gateway/i);
    await expect(page.locator(`[data-app-id="${id}"]`)).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

// ---------- 3.4 gateway 404 is idempotent success ----------

// SKIPPED — suspected product defect, tracked in
// https://github.com/srikanth235/centraid/issues/472.
// The idempotent-404 contract this test names was deliberately reversed:
// `deleteApp` routes through `readJson(res, 'delete app')`, which throws on any
// non-2xx, and the comment above it states the intent — "Surface a gateway
// rejection (401/404/409/500) instead of reporting a phantom success"
// (packages/client/src/gateway-client-editing.ts:365-376).
// The result is self-contradictory rather than merely changed: the gateway
// drops the app from its registry on a 404, so the TILE DISAPPEARS while the
// user is simultaneously shown `Could not delete: delete app: {"error":
// "not_found"}`. The delete both succeeded and reported failure.
// #496 P8 — product decision locked to current client contract: non-2xx is
// surfaced as failure (gateway-client-editing.ts). Assert that path rather than
// leaving an unconditional skip that paints the suite green without covering
// the 404 branch.
test('3.4 — 404 from the gateway surfaces a delete error (not phantom success)', async () => {
  const id = 'pomo-gone';
  gateway.state.apps = [appEntry({ id, name: 'Pomodoro' })];
  gateway.state.deleteStatus = 404;
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await markUserApp(page, { id, name: 'Pomodoro' });
    await page.reload();
    await waitForHome(page);

    await openTileMenu(page, id);
    await clickMenuItem(page, 'Delete');
    await expectConfirm(page, 'Delete app?');
    await confirmDelete(page);

    // Client throws on non-2xx → toast error path; no "Deleted …" success toast.
    await expect(page.locator('[data-global-toast]')).toContainText(
      /Could not delete|not_found|delete app/i,
      {
        timeout: 10_000,
      },
    );
  } finally {
    await closeApp(app);
  }
});

// ---------- 3.5 dismiss paths ----------

async function openDeleteDialog(page: import('@playwright/test').Page, id: string): Promise<void> {
  await openTileMenu(page, id);
  await clickMenuItem(page, 'Delete');
  await expectConfirm(page, 'Delete app?');
}

test('3.5a — Cancel keeps the tile and fires no DELETE', async () => {
  const id = 'cancel-me';
  gateway.state.apps = [appEntry({ id, name: 'Cancel Me' })];
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await markUserApp(page, { id, name: 'Cancel Me' });
    await page.reload();
    await waitForHome(page);
    await openDeleteDialog(page, id);
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator(`[data-app-id="${id}"]`)).toBeVisible();
    expect(deletes(gateway).length).toBe(0);
  } finally {
    await closeApp(app);
  }
});

test('3.5b — Escape dismisses without firing DELETE', async () => {
  const id = 'escape-me';
  gateway.state.apps = [appEntry({ id, name: 'Escape App' })];
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await markUserApp(page, { id, name: 'Escape App' });
    await page.reload();
    await waitForHome(page);
    await openDeleteDialog(page, id);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator(`[data-app-id="${id}"]`)).toBeVisible();
    expect(deletes(gateway).length).toBe(0);
  } finally {
    await closeApp(app);
  }
});

test('3.5d — Enter confirms the delete', async () => {
  const id = 'enter-me';
  gateway.state.apps = [appEntry({ id, name: 'Enter App' })];
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await markUserApp(page, { id, name: 'Enter App' });
    await page.reload();
    await waitForHome(page);
    await openDeleteDialog(page, id);
    await page.keyboard.press('Enter');
    await expect(page.locator(`[data-app-id="${id}"]`)).toHaveCount(0);
    // Realigned copy — see HomeRoute.tsx:148.
    await expect(page.locator('[data-global-toast]')).toContainText('Deleted "Enter App"');
    expect(deletes(gateway, id).length).toBeGreaterThanOrEqual(1);
  } finally {
    await closeApp(app);
  }
});

test('3.5c — backdrop click dismisses the dialog', async () => {
  const id = 'backdrop-me';
  gateway.state.apps = [appEntry({ id, name: 'Backdrop App' })];
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await markUserApp(page, { id, name: 'Backdrop App' });
    await page.reload();
    await waitForHome(page);
    await openDeleteDialog(page, id);
    await page.getByTestId('modal-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator(`[data-app-id="${id}"]`)).toBeVisible();
    expect(deletes(gateway).length).toBe(0);
  } finally {
    await closeApp(app);
  }
});
