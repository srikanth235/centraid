import { test, expect } from '@playwright/test';
import {
  automationRow,
  automationTurnItem,
  automationTurnRecord,
  cleanupEnv,
  closeApp,
  confirmDelete,
  expectConfirm,
  gotoNav,
  launchApp,
  makeEnv,
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

/** Overflow menu (⋯) holds Edit / Pause·Resume / Delete after the chat-thread redesign. */
async function openAutomationMenu(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('automation-menu-trigger').click();
  await expect(page.getByRole('menu')).toBeVisible();
}

/** Run cards open the viewer via Details / View details, not the entry shell. */
async function openRunDetails(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('run-entry').first().waitFor({ timeout: 15_000 });
  await page.getByTestId('run-details').first().click({ timeout: 15_000 });
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
    const errorCard = page.getByTestId('automations-error');
    await expect(errorCard).toContainText("Couldn't load automations");
    const retry = errorCard.getByRole('button', { name: 'Retry' });
    // Error UI must settle before we rewire the mock — a mid-flight reload
    // would still see 500 and re-paint the card under the cursor.
    await expect(retry).toBeVisible();
    await expect(retry).toBeEnabled();
    // Recover: fix the gateway, click Retry.
    gateway.state.automationsStatus = 200;
    gateway.state.automations = [automationRow({ id: 'digest', name: 'Inbox Digest' })];
    await retry.click();
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

    await page.getByRole('textbox', { name: 'Name' }).fill('Inbox Digest');
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

test('8.5 — toggling the lifecycle menu posts set-enabled; a failed toggle toasts', async () => {
  gateway.state.automations = [
    automationRow({ id: 'digest', name: 'Inbox Digest', enabled: true }),
  ];
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await page.getByTestId('automation-row').filter({ hasText: 'Inbox Digest' }).click();
    await expect(page.getByTestId('automation-thread')).toBeVisible();

    // Enable/disable lives in the ⋯ menu (Pause when enabled, Resume when not).
    // Success is silent — toast only on failure. set-enabled is async
    // (opens an app session first), so poll the mock rather than assert
    // synchronously. Never-run rows become draft (not "paused") when
    // disabled, so re-open the menu and assert Resume.
    await openAutomationMenu(page);
    await expect(page.getByTestId('automation-menu-toggle')).toContainText('Pause');
    await page.getByTestId('automation-menu-toggle').click();
    await expect
      .poll(() =>
        gateway.calls.some(
          (c) => c.method === 'POST' && c.pathname === '/centraid/_automations/set-enabled',
        ),
      )
      .toBe(true);
    await openAutomationMenu(page);
    await expect(page.getByTestId('automation-menu-toggle')).toContainText('Resume');

    // Fault-inject the Resume path — the one that does toast.
    gateway.state.setEnabledStatus = 500;
    await page.getByTestId('automation-menu-toggle').click();
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
    await openAutomationMenu(page);
    await page.getByTestId('automation-menu-delete').click();
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
    await openAutomationMenu(page);
    await page.getByTestId('automation-menu-edit').click();
    await expect(page.getByTestId('automation-editor')).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

// ─────────────────────────── §9 runs & monitoring ───────────────────────────

function seedSuccessfulTurn(g: MockGateway, automationRef: string, turnId: string): void {
  g.state.nextAutomationTurnId = turnId;
  g.state.automationTurnsById[turnId] = automationTurnRecord({
    turnId,
    automationId: automationRef,
    ok: true,
    summary: 'All done.',
  });
  g.state.automationItemsByTurn[turnId] = [
    automationTurnItem({ turnId, ordinal: 1, kind: 'tool', name: 'fetch_inbox', ok: true }),
  ];
  g.state.automationTurnFrames = [
    { data: { type: 'turn.start', turnId }, delayMs: 20 },
    {
      data: {
        type: 'item.start',
        itemId: `${turnId}-i1`,
        ordinal: 1,
        kind: 'tool',
        name: 'fetch_inbox',
      },
      delayMs: 20,
    },
    {
      data: {
        type: 'item.end',
        itemId: `${turnId}-i1`,
        ordinal: 1,
        ok: true,
        durationMs: 1000,
      },
      delayMs: 20,
    },
    { data: { type: 'turn.end', turnId, ok: true }, delayMs: 20 },
  ];
}

test('9.1 + 9.2 — Run now opens the forensic viewer and the timeline resolves to success', async () => {
  const row = automationRow({ id: 'digest', name: 'Inbox Digest' });
  gateway.state.automations = [row];
  seedSuccessfulTurn(gateway, row.ref as string, 'turn-ok');
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await page.getByTestId('automation-row').filter({ hasText: 'Inbox Digest' }).click();
    await page.getByRole('button', { name: 'Run now' }).click();
    // The fired turn lands in the thread feed; Details opens the forensic
    // viewer, whose timeline resolves to a successful final node.
    await openRunDetails(page);
    await expect(page.getByTestId('run-view')).toBeVisible();
    await expect(page.getByTestId('timeline-final')).toHaveAttribute('data-status', 'ok', {
      timeout: 10_000,
    });
    expect(
      gateway.calls.some(
        (c) => c.method === 'POST' && c.pathname === '/centraid/_automations/turn-now',
      ),
    ).toBe(true);
  } finally {
    await closeApp(app);
  }
});

test('9.3 — a failed turn surfaces the failure outcome', async () => {
  const row = automationRow({ id: 'digest', name: 'Inbox Digest' });
  gateway.state.automations = [row];
  gateway.state.nextAutomationTurnId = 'turn-fail';
  gateway.state.automationTurnsById['turn-fail'] = automationTurnRecord({
    turnId: 'turn-fail',
    automationId: row.ref as string,
    ok: false,
    error: 'Boom.',
  });
  gateway.state.automationItemsByTurn['turn-fail'] = [
    automationTurnItem({ turnId: 'turn-fail', ordinal: 1, ok: false, error: 'Boom.' }),
  ];
  gateway.state.automationTurnFrames = [
    { data: { type: 'turn.start', turnId: 'turn-fail' }, delayMs: 20 },
    {
      data: {
        type: 'item.start',
        itemId: 'turn-fail-i1',
        ordinal: 1,
        kind: 'tool',
        name: 'fetch_inbox',
      },
      delayMs: 20,
    },
    {
      data: {
        type: 'item.end',
        itemId: 'turn-fail-i1',
        ordinal: 1,
        ok: false,
        error: 'Boom.',
        durationMs: 500,
      },
      delayMs: 20,
    },
    { data: { type: 'turn.end', turnId: 'turn-fail', ok: false, error: 'Boom.' }, delayMs: 20 },
  ];
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await page.getByTestId('automation-row').filter({ hasText: 'Inbox Digest' }).click();
    await page.getByRole('button', { name: 'Run now' }).click();
    await openRunDetails(page);
    await expect(page.getByTestId('timeline-final')).toHaveAttribute('data-status', 'fail', {
      timeout: 10_000,
    });
  } finally {
    await closeApp(app);
  }
});

test('9.4 + 9.9 — the forensic timeline uses the shared tool-and-answer transcript', async () => {
  const row = automationRow({ id: 'digest', name: 'Inbox Digest' });
  gateway.state.automations = [row];
  seedSuccessfulTurn(gateway, row.ref as string, 'turn-ok');
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await page.getByTestId('automation-row').filter({ hasText: 'Inbox Digest' }).click();
    await page.getByRole('button', { name: 'Run now' }).click();
    await openRunDetails(page);
    await expect(page.getByTestId('timeline-final')).toHaveAttribute('data-status', 'ok', {
      timeout: 10_000,
    });

    const transcript = page.getByTestId('automation-turn-messages');
    await expect(transcript).toContainText('1 tool');
    await expect(transcript).toContainText('All done.');
  } finally {
    await closeApp(app);
  }
});

test('9.7 — Run again fires another turn from the automation thread', async () => {
  const row = automationRow({ id: 'digest', name: 'Inbox Digest' });
  gateway.state.automations = [row];
  seedSuccessfulTurn(gateway, row.ref as string, 'turn-ok');
  const { app, page } = await launchApp(env);
  try {
    await openAutomations(page);
    await page.getByTestId('automation-row').filter({ hasText: 'Inbox Digest' }).click();
    await page.getByRole('button', { name: 'Run now' }).click();
    // Re-run lives on the automation thread card ("Run again"), not the
    // run-view detail (those in-view controls were removed as noise).
    await page.getByTestId('run-entry').first().waitFor({ timeout: 15_000 });
    await expect(page.getByTestId('run-details').first()).toBeVisible({ timeout: 15_000 });
    const before = gateway.countCalls('POST', (p) => p === '/centraid/_automations/turn-now');
    await page.getByRole('button', { name: 'Run again' }).first().click();
    await expect
      .poll(() => gateway.countCalls('POST', (p) => p === '/centraid/_automations/turn-now'))
      .toBeGreaterThan(before);
  } finally {
    await closeApp(app);
  }
});
