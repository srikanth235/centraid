import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  cleanupEnv,
  clickContextDelete,
  confirmDelete,
  expectConfirm,
  launchApp,
  makeEnv,
  openTileMenu,
  seedDraftProject,
  seedPublishedApp,
  seedSettings,
  startMockGateway,
  type MockGateway,
  type TestEnv,
} from './fixtures';

/**
 * End-to-end coverage for the app-deletion flow (the same five scenarios laid
 * out in the manual smoke-test plan). Each test owns:
 *
 *   - a fresh tmp workspace (userData + projectsDir)
 *   - a fresh mock gateway on a random loopback port
 *   - its own Electron process
 *
 * so state never leaks across tests.
 */

let env: TestEnv;
let gateway: MockGateway;

test.beforeEach(async () => {
  env = await makeEnv();
  gateway = await startMockGateway();
  await seedSettings(env, gateway);
});

test.afterEach(async () => {
  await gateway.close().catch(() => undefined);
  await cleanupEnv(env);
});

// ---------- Scenario A: draft delete (no gateway) ----------

test('A — deleting a draft wipes the project dir and never touches the gateway', async () => {
  const draftId = 'draft-grocery-abc';
  await seedDraftProject(env, { id: draftId, name: 'Grocery list' });

  const { app, page } = await launchApp(env);
  try {
    await openTileMenu(page, 'Grocery list');
    await clickContextDelete(page);
    await expectConfirm(page, 'Delete draft?');
    await confirmDelete(page);

    await expect(page.locator('.app-tile', { hasText: 'Grocery list' })).toHaveCount(0);
    await expect(page.locator('.global-toast')).toContainText('Deleted draft');

    // Project dir is gone on disk.
    await expect(fs.stat(path.join(env.projectsDir, draftId))).rejects.toThrow(/ENOENT/);

    // Gateway never received a DELETE — drafts are local-only.
    expect(gateway.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  } finally {
    await app.close();
  }
});

// ---------- Scenario B: published app, gateway reachable ----------

test('B — deleting a published app calls the gateway and removes local state', async () => {
  const appId = 'todo-abc123';
  const { app, page } = await launchApp(env);
  try {
    await seedPublishedApp(env, page, { id: appId, name: 'My Todos' });
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    await openTileMenu(page, 'My Todos');
    await clickContextDelete(page);
    await expectConfirm(page, 'Delete app?');
    await confirmDelete(page);

    await expect(page.locator('.app-tile', { hasText: 'My Todos' })).toHaveCount(0);
    await expect(page.locator('.global-toast')).toContainText('Removed "My Todos"');

    // Gateway received the DELETE with auth.
    const deletes = gateway.calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.pathname).toBe(`/centraid/_apps/${appId}`);
    expect(deletes[0]!.auth).toMatch(/^Bearer /);

    // Local project dir is gone.
    await expect(fs.stat(path.join(env.projectsDir, appId))).rejects.toThrow(/ENOENT/);

    // userApps in localStorage no longer contains the deleted app.
    const stored = await page.evaluate(
      () => localStorage.getItem('centraid.v1.home.userApps') ?? '[]',
    );
    expect(JSON.parse(stored)).toEqual([]);
  } finally {
    await app.close();
  }
});

// ---------- Scenario C: published app, gateway offline (error surfacing) ----------

test('C — gateway offline: surfaces error, tile remains, no local cleanup', async () => {
  const appId = 'habit-xyz789';
  const { app, page } = await launchApp(env);
  try {
    await seedPublishedApp(env, page, { id: appId, name: 'Daily Habits' });
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    // Take the gateway offline before clicking delete.
    await gateway.close();

    await openTileMenu(page, 'Daily Habits');
    await clickContextDelete(page);
    await expectConfirm(page, 'Delete app?');
    await confirmDelete(page);

    // Error toast surfaces the failure (no longer silently swallowed).
    await expect(page.locator('.global-toast')).toContainText(/Could not delete.*gateway/i);

    // Tile is still on home — user can retry.
    await expect(page.locator('.app-tile', { hasText: 'Daily Habits' })).toBeVisible();

    // Local project dir is untouched.
    await expect(fs.stat(path.join(env.projectsDir, appId))).resolves.toBeTruthy();

    // userApps entry preserved.
    const stored = await page.evaluate(
      () => localStorage.getItem('centraid.v1.home.userApps') ?? '[]',
    );
    expect(JSON.parse(stored)).toHaveLength(1);
  } finally {
    await app.close();
  }
});

// ---------- Scenario D: gateway returns 404 (idempotent — already gone) ----------

test('D — 404 from gateway is treated as success (deregister is idempotent)', async () => {
  const appId = 'pomo-already-gone';
  const { app, page } = await launchApp(env);
  try {
    await seedPublishedApp(env, page, { id: appId, name: 'Pomodoro' });
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    gateway.deleteStatus = 404;

    await openTileMenu(page, 'Pomodoro');
    await clickContextDelete(page);
    await expectConfirm(page, 'Delete app?');
    await confirmDelete(page);

    // Treated as success — no error toast.
    await expect(page.locator('.global-toast')).toContainText('Removed "Pomodoro"');
    await expect(page.locator('.app-tile', { hasText: 'Pomodoro' })).toHaveCount(0);

    // Local cleanup still ran.
    await expect(fs.stat(path.join(env.projectsDir, appId))).rejects.toThrow(/ENOENT/);
  } finally {
    await app.close();
  }
});

// ---------- Scenario E: cancel paths ----------

test('E.1 — Cancel button dismisses the dialog and keeps the tile', async () => {
  const appId = 'cancel-cancel';
  const { app, page } = await launchApp(env);
  try {
    await seedPublishedApp(env, page, { id: appId, name: 'Cancel Me' });
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    await openTileMenu(page, 'Cancel Me');
    await clickContextDelete(page);
    await expectConfirm(page, 'Delete app?');

    await page.locator('.modal-card .btn-ghost', { hasText: 'Cancel' }).click();

    await expect(page.locator('.modal-card[role="dialog"]')).toHaveCount(0);
    await expect(page.locator('.app-tile', { hasText: 'Cancel Me' })).toBeVisible();
    expect(gateway.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  } finally {
    await app.close();
  }
});

test('E.2 — Escape dismisses the dialog without firing IPC', async () => {
  const appId = 'escape-me';
  const { app, page } = await launchApp(env);
  try {
    await seedPublishedApp(env, page, { id: appId, name: 'Escape App' });
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    await openTileMenu(page, 'Escape App');
    await clickContextDelete(page);
    await expectConfirm(page, 'Delete app?');

    await page.keyboard.press('Escape');

    await expect(page.locator('.modal-card[role="dialog"]')).toHaveCount(0);
    await expect(page.locator('.app-tile', { hasText: 'Escape App' })).toBeVisible();
    expect(gateway.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  } finally {
    await app.close();
  }
});

test('E.3 — backdrop click dismisses the dialog', async () => {
  const appId = 'backdrop-app';
  const { app, page } = await launchApp(env);
  try {
    await seedPublishedApp(env, page, { id: appId, name: 'Backdrop App' });
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    await openTileMenu(page, 'Backdrop App');
    await clickContextDelete(page);
    await expectConfirm(page, 'Delete app?');

    // Click the backdrop at a position guaranteed to be outside the card.
    await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } });

    await expect(page.locator('.modal-card[role="dialog"]')).toHaveCount(0);
    await expect(page.locator('.app-tile', { hasText: 'Backdrop App' })).toBeVisible();
    expect(gateway.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  } finally {
    await app.close();
  }
});

test('E.4 — Enter confirms when the dialog is focused', async () => {
  const appId = 'enter-confirm';
  const { app, page } = await launchApp(env);
  try {
    await seedPublishedApp(env, page, { id: appId, name: 'Enter App' });
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    await openTileMenu(page, 'Enter App');
    await clickContextDelete(page);
    await expectConfirm(page, 'Delete app?');

    await page.keyboard.press('Enter');

    await expect(page.locator('.app-tile', { hasText: 'Enter App' })).toHaveCount(0);
    await expect(page.locator('.global-toast')).toContainText('Removed "Enter App"');
    expect(gateway.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  } finally {
    await app.close();
  }
});
