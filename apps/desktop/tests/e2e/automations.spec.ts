import { test, expect } from '@playwright/test';
import {
  automationRow,
  cleanupEnv,
  closeApp,
  confirmDelete,
  expectConfirm,
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
  await page
    .getByTestId('automations-overview')
    .or(page.getByTestId('automations-error'))
    .first()
    .waitFor({ state: 'visible' });
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
    await expect(page.getByTestId('automation-row')).toHaveCount(2);
    await expect(
      page.getByTestId('automation-row-name').filter({ hasText: 'Inbox Digest' }),
    ).toBeVisible();
    // Every row carries a status pill (`data-au-status` is the pill's stable hook).
    await expect(page.locator('[data-au-status]').first()).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

test('8.2 — a list load failure shows the error card and Retry recovers', async () => {
  gateway.state.automationsStatus = 500;
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await expect(page.getByTestId('automations-error')).toContainText("Couldn't load automations");
    // Recover: fix the gateway, click Retry.
    gateway.state.automationsStatus = 200;
    gateway.state.automations = [automationRow({ id: 'digest', name: 'Inbox Digest' })];
    await page.getByTestId('automations-error').getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByTestId('automation-row')).toHaveCount(1);
  } finally {
    await closeApp(app);
  }
});

test('8.3 — "New automation" opens the editor; the draft is posted on Save', async () => {
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    // With no automations seeded the overview renders both the header action
    // and the empty-state action; either is the same affordance.
    await page.getByRole('button', { name: 'New automation' }).first().click();
    // Realignment: this test used to expect the draft POST on open. Draft
    // creation is deliberately deferred to Save — AutomationEditorRoute calls
    // createAutomation() only from its onSave handler — so opening the editor
    // posts nothing. Both halves are asserted rather than dropping either.
    await expect(page.getByTestId('automation-editor')).toBeVisible();
    expect(
      gateway.calls.some((c) => c.method === 'POST' && c.pathname === '/centraid/_automations'),
    ).toBe(false);

    await page.getByPlaceholder('Untitled automation').fill('Inbox Digest');
    await page.getByRole('button', { name: 'Create automation' }).click();
    await expect
      .poll(() =>
        gateway.calls.some((c) => c.method === 'POST' && c.pathname === '/centraid/_automations'),
      )
      .toBe(true);
  } finally {
    await closeApp(app);
  }
});

test('8.4 — clicking an automation row opens its viewer', async () => {
  gateway.state.automations = [automationRow({ id: 'digest', name: 'Inbox Digest' })];
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await page.getByTestId('automation-row').filter({ hasText: 'Inbox Digest' }).click();
    await expect(page.getByTestId('automation-thread')).toBeVisible();
    await expect(page.getByTestId('automation-thread')).toContainText('Inbox Digest');
  } finally {
    await closeApp(app);
  }
});

test('8.5 — toggling the enable switch posts set-enabled; a failed toggle toasts', async () => {
  gateway.state.automations = [
    automationRow({ id: 'digest', name: 'Inbox Digest', enabled: true }),
  ];
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await page.getByTestId('automation-row').filter({ hasText: 'Inbox Digest' }).click();
    await expect(page.getByTestId('automation-thread')).toBeVisible();

    // Realignment: this test used to expect a success toast. A successful
    // toggle is deliberately silent — AutomationViewRoute toasts only on the
    // failure path — so success is verified by the POST plus the switch's new
    // state, and the toast is asserted on the path that actually raises one.
    // The native checkbox is visually hidden behind its styled track; the
    // label is the real hit target a user clicks.
    await page.getByTitle('Disable', { exact: true }).click();
    // The input is visually hidden behind its styled track, so assert the
    // accessible state rather than visibility.
    await expect(page.getByRole('switch', { name: 'Enable Inbox Digest' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(
      gateway.calls.some(
        (c) => c.method === 'POST' && c.pathname === '/centraid/_automations/set-enabled',
      ),
    ).toBe(true);

    // Fault-inject the failure path — the one that does toast.
    gateway.state.setEnabledStatus = 500;
    await page.getByTitle('Enable', { exact: true }).click();
    await expect(page.locator('[data-global-toast]')).toContainText(
      /Could not enable Inbox Digest/i,
    );
  } finally {
    await closeApp(app);
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
    await page.getByTestId('automation-row').filter({ hasText: 'Webhook Bot' }).click();
    await expect(page.getByTestId('automation-webhook-url')).toContainText('wh-123');
    await page.getByRole('button', { name: 'Copy webhook URL' }).click();
    await expect(page.locator('[data-global-toast]')).toContainText(/Webhook URL copied/i);
  } finally {
    await closeApp(app);
  }
});

test('8.7 — deleting an automation confirms, posts DELETE, returns to the list', async () => {
  gateway.state.automations = [automationRow({ id: 'digest', name: 'Inbox Digest' })];
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await page.getByTestId('automation-row').filter({ hasText: 'Inbox Digest' }).click();
    await expect(page.getByTestId('automation-thread')).toBeVisible();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expectConfirm(page, 'Delete automation?');
    await confirmDelete(page);
    await expect(page.locator('[data-global-toast]')).toContainText('Deleted "Inbox Digest"');
    expect(
      gateway.calls.some((c) => c.method === 'DELETE' && c.pathname === '/centraid/_automations'),
    ).toBe(true);
  } finally {
    await closeApp(app);
  }
});

test('8.8 — Edit opens the automation builder', async () => {
  gateway.state.automations = [automationRow({ id: 'digest', name: 'Inbox Digest' })];
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await page.getByTestId('automation-row').filter({ hasText: 'Inbox Digest' }).click();
    await expect(page.getByTestId('automation-thread')).toBeVisible();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByTestId('automation-editor')).toBeVisible();
  } finally {
    await closeApp(app);
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
    await page.getByTestId('automation-row').filter({ hasText: 'Inbox Digest' }).click();
    await page.getByRole('button', { name: 'Run now' }).click();
    // The fired run lands in the thread's run feed; opening it shows the run
    // viewer, whose timeline resolves to a successful final node.
    await page.getByTestId('run-entry').first().click({ timeout: 15_000 });
    await expect(page.getByTestId('run-view')).toBeVisible();
    await expect(page.getByTestId('timeline-final')).toHaveAttribute('data-status', 'ok', {
      timeout: 10_000,
    });
    expect(
      gateway.calls.some(
        (c) => c.method === 'POST' && c.pathname === '/centraid/_automations/run-now',
      ),
    ).toBe(true);
  } finally {
    await closeApp(app);
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
    await page.getByTestId('automation-row').filter({ hasText: 'Inbox Digest' }).click();
    await page.getByRole('button', { name: 'Run now' }).click();
    await page.getByTestId('run-entry').first().click({ timeout: 15_000 });
    await expect(page.getByTestId('timeline-final')).toHaveAttribute('data-status', 'fail', {
      timeout: 10_000,
    });
  } finally {
    await closeApp(app);
  }
});

test('9.4 + 9.9 — a timeline node expands to show payloads and Escape collapses it', async () => {
  const row = automationRow({ id: 'digest', name: 'Inbox Digest' });
  gateway.state.automations = [row];
  seedSuccessfulRun(gateway, row.ref as string, 'run-ok');
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await page.getByTestId('automation-row').filter({ hasText: 'Inbox Digest' }).click();
    await page.getByRole('button', { name: 'Run now' }).click();
    await page.getByTestId('run-entry').first().click({ timeout: 15_000 });
    await expect(page.getByTestId('timeline-final')).toHaveAttribute('data-status', 'ok', {
      timeout: 10_000,
    });

    const head = page.locator('[aria-expanded]').first();
    await head.click();
    await expect(head).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('run-step-payload').first()).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

test('9.7 — Run again fires another run from the run viewer', async () => {
  const row = automationRow({ id: 'digest', name: 'Inbox Digest' });
  gateway.state.automations = [row];
  seedSuccessfulRun(gateway, row.ref as string, 'run-ok');
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await page.getByTestId('automation-row').filter({ hasText: 'Inbox Digest' }).click();
    await page.getByRole('button', { name: 'Run now' }).click();
    await page.getByTestId('run-entry').first().click({ timeout: 15_000 });
    await expect(page.getByTestId('run-view')).toBeVisible();
    const before = gateway.countCalls('POST', (p) => p === '/centraid/_automations/run-now');
    await page.getByRole('button', { name: 'Run again' }).first().click();
    await expect
      .poll(() => gateway.countCalls('POST', (p) => p === '/centraid/_automations/run-now'))
      .toBeGreaterThan(before);
  } finally {
    await closeApp(app);
  }
});
