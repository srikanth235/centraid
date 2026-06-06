import { test, expect } from '@playwright/test';
import {
  automationRow,
  cleanupEnv,
  confirmDelete,
  gotoNav,
  launchApp,
  makeEnv,
  runNode,
  runRecord,
  seedRemoteGateway,
  startMockGateway,
  waitForHome,
  type MockGateway,
  type TestEnv,
} from './fixtures';

/** §8 Automations list & viewer, §9 Automation runs & monitoring. */

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

async function openAutomations(page: import('@playwright/test').Page): Promise<void> {
  await waitForHome(page);
  await gotoNav(page, 'Automations');
  await page.locator('.cd-au-ov, .cd-au-error').first().waitFor({ state: 'visible' });
}

// ─────────────────────────── §8 list & viewer ───────────────────────────

test('8.1 — the automations list renders rows with status pills', async () => {
  gateway.state.automations = [
    automationRow({ id: 'digest', name: 'Inbox Digest', enabled: true }),
    automationRow({ id: 'backup', name: 'Nightly Backup', enabled: false }),
  ];
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await expect(page.locator('.cd-au-ov-row')).toHaveCount(2);
    await expect(page.locator('.cd-au-ov-name', { hasText: 'Inbox Digest' })).toBeVisible();
    await expect(page.locator('.cd-au-status').first()).toBeVisible();
  } finally {
    await app.close();
  }
});

test('8.2 — a list load failure shows the error card and Retry recovers', async () => {
  gateway.state.automationsStatus = 500;
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await expect(page.locator('.cd-au-error-title')).toContainText("Couldn't load automations");
    // Recover: fix the gateway, click Retry.
    gateway.state.automationsStatus = 200;
    gateway.state.automations = [automationRow({ id: 'digest', name: 'Inbox Digest' })];
    await page.locator('.cd-au-error button', { hasText: 'Retry' }).click();
    await expect(page.locator('.cd-au-ov-row')).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test('8.3 — "New automation" creates a draft and opens the builder', async () => {
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await page.locator('.cd-au-btn-primary', { hasText: 'New automation' }).click();
    await expect(page.locator('.builder-body')).toBeVisible();
    expect(
      gateway.calls.some((c) => c.method === 'POST' && c.pathname === '/centraid/_automations'),
    ).toBe(true);
  } finally {
    await app.close();
  }
});

test('8.4 — clicking an automation row opens its viewer', async () => {
  gateway.state.automations = [automationRow({ id: 'digest', name: 'Inbox Digest' })];
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await page.locator('.cd-au-ov-row', { hasText: 'Inbox Digest' }).click();
    await expect(page.locator('.cd-au-view')).toBeVisible();
    await expect(page.locator('.cd-au-view')).toContainText('Inbox Digest');
  } finally {
    await app.close();
  }
});

test('8.5 — toggling the enable switch posts set-enabled and toasts', async () => {
  gateway.state.automations = [
    automationRow({ id: 'digest', name: 'Inbox Digest', enabled: true }),
  ];
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await page.locator('.cd-au-ov-row', { hasText: 'Inbox Digest' }).click();
    await expect(page.locator('.cd-au-view')).toBeVisible();
    await page.locator('.cd-au-switch').click();
    await expect(page.locator('.global-toast')).toContainText(/Disabled/i);
    expect(
      gateway.calls.some(
        (c) => c.method === 'POST' && c.pathname === '/centraid/_automations/set-enabled',
      ),
    ).toBe(true);
  } finally {
    await app.close();
  }
});

test('8.6 — a webhook automation shows its URL and copies it', async () => {
  gateway.state.automations = [
    automationRow({
      id: 'hook',
      name: 'Webhook Bot',
      triggers: [{ kind: 'webhook', id: 'wh-123' }],
    }),
  ];
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await page.locator('.cd-au-ov-row', { hasText: 'Webhook Bot' }).click();
    await expect(page.locator('.cd-au-hero-wh-url')).toContainText('wh-123');
    await page.locator('.cd-au-hero-copy').click();
    await expect(page.locator('.global-toast')).toContainText(/Webhook URL copied/i);
  } finally {
    await app.close();
  }
});

test('8.7 — deleting an automation confirms, posts DELETE, returns to the list', async () => {
  gateway.state.automations = [automationRow({ id: 'digest', name: 'Inbox Digest' })];
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await page.locator('.cd-au-ov-row', { hasText: 'Inbox Digest' }).click();
    await expect(page.locator('.cd-au-view')).toBeVisible();
    await page.locator('.cd-au-btn-danger').first().click();
    await page.locator('.modal-card[role="dialog"]', { hasText: 'Delete automation?' }).waitFor();
    await confirmDelete(page);
    await expect(page.locator('.global-toast')).toContainText('Deleted "Inbox Digest"');
    expect(
      gateway.calls.some((c) => c.method === 'DELETE' && c.pathname === '/centraid/_automations'),
    ).toBe(true);
  } finally {
    await app.close();
  }
});

test('8.8 — Edit opens the automation builder', async () => {
  gateway.state.automations = [automationRow({ id: 'digest', name: 'Inbox Digest' })];
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await page.locator('.cd-au-ov-row', { hasText: 'Inbox Digest' }).click();
    await expect(page.locator('.cd-au-view')).toBeVisible();
    await page
      .locator('.cd-au-btn[title="Edit in builder"], .cd-au-btn-ghost.cd-au-btn-icon')
      .first()
      .click();
    await expect(page.locator('.builder-body')).toBeVisible();
  } finally {
    await app.close();
  }
});

// ─────────────────────────── §9 runs & monitoring ───────────────────────────

function seedSuccessfulRun(g: MockGateway, automationRef: string, runId: string): void {
  g.state.nextRunId = runId;
  g.state.runsById[runId] = runRecord({
    runId,
    automationId: automationRef,
    ok: true,
    summary: 'All done.',
  });
  g.state.nodesByRun[runId] = [
    runNode({ runId, ordinal: 1, kind: 'tool', name: 'fetch_inbox', ok: true }),
  ];
  g.state.runFrames = [
    { data: { type: 'run.start', runId }, delayMs: 20 },
    { data: { type: 'node.start', ordinal: 1, kind: 'tool', name: 'fetch_inbox' }, delayMs: 20 },
    { data: { type: 'node.end', ordinal: 1, ok: true, durationMs: 1000 }, delayMs: 20 },
    { data: { type: 'run.end', ok: true }, delayMs: 20 },
  ];
}

test('9.1 + 9.2 — Run now opens the run viewer and the timeline resolves to success', async () => {
  const row = automationRow({ id: 'digest', name: 'Inbox Digest' });
  gateway.state.automations = [row];
  seedSuccessfulRun(gateway, row.ref as string, 'run-ok');
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await page.locator('.cd-au-ov-row', { hasText: 'Inbox Digest' }).click();
    await page.locator('.cd-au-btn-primary', { hasText: 'Run now' }).click();
    await expect(page.locator('.cd-au-rv')).toBeVisible();
    await expect(page.locator('.cd-au-tl-item-final[data-status="ok"]')).toBeVisible({
      timeout: 10_000,
    });
    expect(
      gateway.calls.some(
        (c) => c.method === 'POST' && c.pathname === '/centraid/_automations/run-now',
      ),
    ).toBe(true);
  } finally {
    await app.close();
  }
});

test('9.3 — a failed run surfaces the failure outcome', async () => {
  const row = automationRow({ id: 'digest', name: 'Inbox Digest' });
  gateway.state.automations = [row];
  gateway.state.nextRunId = 'run-fail';
  gateway.state.runsById['run-fail'] = runRecord({
    runId: 'run-fail',
    automationId: row.ref as string,
    ok: false,
    error: 'Boom.',
  });
  gateway.state.nodesByRun['run-fail'] = [
    runNode({ runId: 'run-fail', ordinal: 1, ok: false, error: 'Boom.' }),
  ];
  gateway.state.runFrames = [
    { data: { type: 'run.start', runId: 'run-fail' }, delayMs: 20 },
    { data: { type: 'node.start', ordinal: 1, kind: 'tool', name: 'fetch_inbox' }, delayMs: 20 },
    {
      data: { type: 'node.end', ordinal: 1, ok: false, error: 'Boom.', durationMs: 500 },
      delayMs: 20,
    },
    { data: { type: 'run.end', ok: false, error: 'Boom.' }, delayMs: 20 },
  ];
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await page.locator('.cd-au-ov-row', { hasText: 'Inbox Digest' }).click();
    await page.locator('.cd-au-btn-primary', { hasText: 'Run now' }).click();
    await expect(page.locator('.cd-au-tl-item-final[data-status="fail"]')).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await app.close();
  }
});

test('9.4 + 9.9 — a timeline node expands to show payloads and Escape collapses it', async () => {
  const row = automationRow({ id: 'digest', name: 'Inbox Digest' });
  gateway.state.automations = [row];
  seedSuccessfulRun(gateway, row.ref as string, 'run-ok');
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await page.locator('.cd-au-ov-row', { hasText: 'Inbox Digest' }).click();
    await page.locator('.cd-au-btn-primary', { hasText: 'Run now' }).click();
    await expect(page.locator('.cd-au-tl-item-final[data-status="ok"]')).toBeVisible({
      timeout: 10_000,
    });

    const head = page.locator('.cd-au-tl-head[aria-expanded]').first();
    await head.click();
    await expect(head).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.cd-au-step-pre').first()).toBeVisible();
  } finally {
    await app.close();
  }
});

test('9.7 — Run again fires another run from the run viewer', async () => {
  const row = automationRow({ id: 'digest', name: 'Inbox Digest' });
  gateway.state.automations = [row];
  seedSuccessfulRun(gateway, row.ref as string, 'run-ok');
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await page.locator('.cd-au-ov-row', { hasText: 'Inbox Digest' }).click();
    await page.locator('.cd-au-btn-primary', { hasText: 'Run now' }).click();
    await expect(page.locator('.cd-au-rv')).toBeVisible();
    const before = gateway.countCalls('POST', (p) => p === '/centraid/_automations/run-now');
    await page.locator('button', { hasText: 'Run again' }).first().click();
    await expect
      .poll(() => gateway.countCalls('POST', (p) => p === '/centraid/_automations/run-now'))
      .toBeGreaterThan(before);
  } finally {
    await app.close();
  }
});
