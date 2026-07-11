#!/usr/bin/env node
// Verify: parked-invocation caller identity (UX/trust fix). Confirms two
// things on the Approvals screen that were both missing before this fix:
//   1. an app-kind parked row shows Locker's DISPLAY NAME, not a raw slug
//      (apps already had a readable id, "locker" -> "Locker", but the
//      caller field is now sourced from consent_app.display_name, not the
//      lookup key, so this checks the plumbing didn't regress it).
//   2. an automation-kind parked row shows a humanized display name instead
//      of the raw automation id slug ("e2e-agent-purge-demo" -> "E2e Agent
//      Purge Demo"), AND a caller-kind badge ("App" / "Automation") next to
//      it -- the exact gap this session's fix closes (ApprovalsScreen.tsx's
//      ParkedRow used to render only row.command + row.caller as plain
//      text, with no indication of who/what was asking).
//
// Setup recipe copied verbatim from the existing suites this session
// audited: Locker install/grant/create/trash/delete-forever from
// flows-approvals-01-setup-park.mjs; automation scaffold/grant/Run now from
// flows-automations-03-corners.mjs (POST /_automations, PUT draft
// handler.js, publish, POST /_vault/agents/<appId>/grants, click Run now).
//
// Run with: node apps/desktop/tests/e2e-live/flows-verify-approvals-identity.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-verify-approvals-identity');

const AGENT_AUTO_ID = 'e2e-agent-purge-demo';
const AGENT_AUTO_NAME = 'E2E agent purge demo';
const PURPOSE = 'dpv:ServiceProvision';
const APP_TARGET_TITLE = 'app-caller target secret';
const AGENT_TARGET_TITLE = 'agent-caller target secret';

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
let session;
const consoleMessages = [];

function wireConsole(p) {
  p.on('console', (msg) => {
    consoleMessages.push({
      text: msg.text(),
      type: msg.type(),
      frameUrl: msg.location()?.url ?? '',
    });
  });
  p.on('pageerror', (err) => {
    consoleMessages.push({ text: `[pageerror] ${err}`, type: 'error', frameUrl: '' });
  });
}

async function step(id, label, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ id, label, verdict: 'pass', ms: Date.now() - t0 });
    console.log(`[PASS] ${id} ${label} (${Date.now() - t0}ms)`);
  } catch (err) {
    results.push({
      id,
      label,
      verdict: 'fail',
      ms: Date.now() - t0,
      error: err?.stack ?? String(err),
    });
    console.error(`[FAIL] ${id} ${label}: ${err}`);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-verify-appr-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `verify-appr-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

function frameLoc(p) {
  return p.frameLocator('iframe[data-centraid-app="1"]');
}

async function gwFetch(pathAndQuery, opts = {}) {
  return page.evaluate(
    async ({ pathAndQuery, method, body }) => {
      const auth = await window.CentraidApi.getGatewayAuth();
      const headers = { 'content-type': 'application/json' };
      if (auth.token) headers.authorization = `Bearer ${auth.token}`;
      if (auth.vaultId) headers['x-centraid-vault'] = auth.vaultId;
      const res = await fetch(`${auth.baseUrl}${pathAndQuery}`, {
        method: method ?? 'GET',
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    },
    { pathAndQuery, method: opts.method, body: opts.body },
  );
}

async function putDraftFile(appId, sessionId, rel, content) {
  return page.evaluate(
    async ({ appId, sessionId, rel, content }) => {
      const auth = await window.CentraidApi.getGatewayAuth();
      const headers = { 'content-type': 'text/plain' };
      if (auth.token) headers.authorization = `Bearer ${auth.token}`;
      if (auth.vaultId) headers['x-centraid-vault'] = auth.vaultId;
      const url = `${auth.baseUrl}/centraid/_apps/${encodeURIComponent(appId)}/files/${rel
        .split('/')
        .map(encodeURIComponent)
        .join('/')}?sessionId=${encodeURIComponent(sessionId)}`;
      const res = await fetch(url, { method: 'PUT', headers, body: content });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    },
    { appId, sessionId, rel, content },
  );
}

async function scaffoldCustomAutomation({ id, name, handlerJs }) {
  const createRes = await gwFetch('/centraid/_automations', {
    method: 'POST',
    body: { id, name, enabled: true, triggers: [], publish: false },
  });
  assert(createRes.status === 201, `automation scaffold failed: ${JSON.stringify(createRes)}`);
  const sessionId = createRes.json?.sessionId;
  assert(
    Boolean(sessionId),
    `expected a sessionId back from the staged scaffold, got ${JSON.stringify(createRes.json)}`,
  );

  const putRes = await putDraftFile(id, sessionId, `automations/${id}/handler.js`, handlerJs);
  assert(putRes.status === 200, `handler.js draft write failed: ${JSON.stringify(putRes)}`);

  const pubRes = await gwFetch(`/centraid/_apps/${id}/publish`, {
    method: 'POST',
    body: { sessionId, message: `seed e2e handler for ${id}` },
  });
  assert(pubRes.status === 201, `publish failed: ${JSON.stringify(pubRes)}`);
  return pubRes.json;
}

/** Owner approval of an automation's agent grant -- POST /_vault/agents/<appId>/grants
 *  (packages/gateway/src/routes/vault-routes.ts:277-296). Enrolls the agent
 *  as a side effect if it wasn't already (vault-plane.ts approveAgentGrant
 *  -> ensureAgentEnrolled) -- this is the enrollment path this fix targets. */
async function approveAgentGrant(appId, scopes) {
  const res = await gwFetch(`/centraid/_vault/agents/${encodeURIComponent(appId)}/grants`, {
    method: 'POST',
    body: { purpose: PURPOSE, scopes },
  });
  assert(
    res.status === 200 && res.json?.grantId,
    `agent grant approval failed: ${JSON.stringify(res)}`,
  );
  return res.json.grantId;
}

async function openAutomationView(name) {
  await navTo(page, 'Automations');
  await page
    .getByRole('heading', { name: 'Automations', level: 1 })
    .waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(300);
  const row = page
    .getByRole('button', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
    .first();
  await row.waitFor({ state: 'visible', timeout: 10_000 });
  await row.click();
  await page
    .getByRole('heading', { name, level: 1 })
    .waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(200);
}

async function openLocker() {
  const sidebarItem = page.getByRole('button', { name: 'Locker', exact: true }).first();
  await sidebarItem.waitFor({ state: 'visible', timeout: 15_000 });
  await sidebarItem.click();
  await page.waitForSelector('iframe[data-centraid-app="1"]', {
    state: 'attached',
    timeout: 20_000,
  });
  const fl = frameLoc(page);
  await fl.locator('.v-newbtn').waitFor({ state: 'visible', timeout: 15_000 });
  return fl;
}

async function createAndTrashLockerItem(fl, title) {
  // A prior flow may have left the list scoped to "Trash" -- a just-created
  // item lands in "All items", not the currently-visible list, so switch
  // back explicitly before looking for it (flows-approvals-01-setup-park.mjs
  // does the same after its own create loop).
  await fl.locator('button.v-nav-item', { hasText: 'All items' }).click();
  await fl.locator('.v-newbtn').click();
  const modal = fl.locator('.kit-modal');
  await modal.waitFor({ state: 'visible', timeout: 8000 });
  await modal.locator('.v-in').first().fill(title);
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await modal.waitFor({ state: 'hidden', timeout: 8000 });
  await fl.locator('.v-item', { hasText: title }).click();
  const detail = fl.locator('.v-detail-inner');
  await detail.waitFor({ state: 'visible', timeout: 8000 });
  await detail.getByRole('button', { name: 'Move to trash' }).click();
  await fl.locator('.v-list').waitFor({ state: 'visible', timeout: 8000 });
}

/** Two-click "Delete forever" (arm + confirm) -- purge_item's confirm:true
 *  makes this park for an app-kind caller instead of executing immediately. */
async function armAndConfirmDeleteForever(fl, title) {
  await fl.locator('button.v-nav-item', { hasText: 'Trash' }).click();
  await fl.locator('.v-item', { hasText: title }).click();
  const detail = fl.locator('.v-detail-inner');
  await detail.waitFor({ state: 'visible', timeout: 8000 });
  const delBtn = detail.getByRole('button', { name: /Delete forever/ });
  await delBtn.click(); // arm
  await page.waitForTimeout(200);
  await delBtn.click(); // confirm -> parks
  await page.waitForTimeout(700);
}

const AGENT_PURGE_HANDLER_JS = `const PURPOSE = 'dpv:ServiceProvision';

/**
 * E2E harness handler (flows-verify-approvals-identity.mjs). Reads the
 * vault as THIS automation's enrolled agent to find the harness's trashed
 * Locker item, then invokes the confirm-gated locker.purge_item command --
 * exercising the automation-as-agent consent-parking path (packages/vault/
 * src/gateway/gateway.ts: any confirm:true command parks for every
 * non-owner-device caller, agents included).
 */
export default async ({ ctx, log }) => {
  const read = await ctx.vault.read({
    entity: 'locker.item',
    where: [{ column: 'deleted_at', op: 'not-null' }],
    limit: 1,
    purpose: PURPOSE,
  });
  const item = (read.rows ?? [])[0];
  if (!item) {
    log.info('no trashed locker item found to purge');
    return { summary: 'no trashed locker item found' };
  }
  const purge = await ctx.vault.invoke({
    command: 'locker.purge_item',
    input: { item_id: item.item_id },
    purpose: PURPOSE,
  });
  log.info('purge_item(' + item.item_id + ') -> ' + JSON.stringify(purge));
  return { summary: 'purge_item -> ' + purge.status, output: purge };
};
`;

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const t0 = Date.now();
  session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  page.setDefaultTimeout(60_000);
  console.log(`[verify-appr] launched (fresh vault) + Home ready in ${Date.now() - t0}ms`);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    await step(
      'install-and-park-app-caller',
      'Install Locker, grant access, park a purge_item under the APP caller identity',
      async () => {
        await navTo(page, 'Discover');
        const lockerCard = page.locator('button[data-kind="app"]', { hasText: 'Locker' }).first();
        await lockerCard.waitFor({ state: 'visible', timeout: 20_000 });
        await lockerCard.click();
        const dialog = page.getByRole('dialog', { name: /^Preview Locker/ });
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await dialog.getByRole('button', { name: 'Use this template' }).click();
        const toast = page.locator('[data-global-toast]');
        await toast.waitFor({ state: 'visible', timeout: 10_000 });

        const fl = await openLocker();
        const consentVisible = await fl
          .locator('#consentBanner')
          .isVisible()
          .catch(() => false);
        if (consentVisible) {
          await page.locator('button[aria-label="App settings"]').click();
          const settingsDialog = page.getByRole('dialog', { name: 'App settings' });
          await settingsDialog.waitFor({ state: 'visible', timeout: 10_000 });
          await settingsDialog.getByRole('button', { name: 'Vault' }).click();
          await page.waitForTimeout(300);
          const grantBtn = settingsDialog.getByRole('button', { name: 'Grant access' });
          if ((await grantBtn.count()) > 0) {
            await grantBtn.click();
            await page.waitForTimeout(1200);
          }
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
        }

        const fl2 = await openLocker();
        await createAndTrashLockerItem(fl2, APP_TARGET_TITLE);
        await armAndConfirmDeleteForever(fl2, APP_TARGET_TITLE);

        const deadline = Date.now() + 15_000;
        let parked = null;
        while (Date.now() < deadline) {
          const blocking = await gwFetch('/centraid/_vault/blocking');
          parked = (blocking.json?.parked ?? []).find((p) => p.command === 'locker.purge_item');
          if (parked) break;
          await page.waitForTimeout(500);
        }
        assert(Boolean(parked), 'expected the app-caller purge_item to park within 15s');
        assert(
          parked.callerKind === 'app',
          `expected callerKind "app", got ${JSON.stringify(parked.callerKind)}`,
        );
        console.log(
          `[verify-appr] app-caller parked entry: callerKind=${parked.callerKind} caller=${JSON.stringify(parked.caller)}`,
        );
      },
    );

    await step(
      'scaffold-and-park-agent-caller',
      'Scaffold an automation, grant its agent Locker access, Run now -> park a purge_item under the AGENT caller identity',
      async () => {
        const fl = await openLocker();
        await createAndTrashLockerItem(fl, AGENT_TARGET_TITLE);

        await scaffoldCustomAutomation({
          id: AGENT_AUTO_ID,
          name: AGENT_AUTO_NAME,
          handlerJs: AGENT_PURGE_HANDLER_JS,
        });
        const grantId = await approveAgentGrant(AGENT_AUTO_ID, [
          { schema: 'locker', verbs: 'read+act' },
        ]);
        console.log(`[verify-appr] approved agent grant ${grantId} for "${AGENT_AUTO_ID}"`);

        const agentsRes = await gwFetch('/centraid/_vault/agents');
        const agentRow = (agentsRes.json?.agents ?? []).find(
          (a) => a.agentId && a.grants?.some((g) => g.grantId === grantId),
        );
        console.log(`[verify-appr] enrolled agent row after grant: ${JSON.stringify(agentRow)}`);
        assert(Boolean(agentRow), 'expected to find the newly-enrolled agent row by its grant id');
        // THE FIX, asserted directly against the enrollment row: the agent's
        // display name must no longer be the raw id slug.
        assert(
          agentRow.name !== AGENT_AUTO_ID,
          `expected the enrolled agent's display name to NOT be the raw slug "${AGENT_AUTO_ID}", got ${JSON.stringify(agentRow.name)}`,
        );
        console.log(
          `[verify-appr] enrolled agent display name: ${JSON.stringify(agentRow.name)} (raw slug was "${AGENT_AUTO_ID}")`,
        );

        await openAutomationView(AGENT_AUTO_NAME);
        const runBtn = page.getByRole('button', { name: /Run now|Starting…/ });
        await runBtn.waitFor({ state: 'visible', timeout: 5_000 });
        await runBtn.click();

        const deadline = Date.now() + 30_000;
        let parked = null;
        while (Date.now() < deadline) {
          const blocking = await gwFetch('/centraid/_vault/blocking');
          parked = (blocking.json?.parked ?? []).find(
            (p) => p.command === 'locker.purge_item' && p.callerKind !== 'app',
          );
          if (parked) break;
          await page.waitForTimeout(700);
        }
        assert(
          Boolean(parked),
          'expected the agent-caller purge_item to park within 30s of Run now',
        );
        assert(
          parked.callerKind === 'agent',
          `expected callerKind "agent", got ${JSON.stringify(parked.callerKind)}`,
        );
        assert(
          parked.caller !== AGENT_AUTO_ID,
          `expected the parked caller display name to NOT be the raw slug "${AGENT_AUTO_ID}", got ${JSON.stringify(parked.caller)}`,
        );
        console.log(
          `[verify-appr] agent-caller parked entry: callerKind=${parked.callerKind} caller=${JSON.stringify(parked.caller)}`,
        );
      },
    );

    await step(
      'approvals-shows-identity',
      'Approvals screen: both parked rows show a display name (not a raw slug) + the right caller-kind chip',
      async () => {
        await page
          .getByRole('button', { name: /^Approvals/ })
          .first()
          .click();
        await page
          .getByRole('heading', { name: 'Approvals', level: 1 })
          .waitFor({ state: 'visible', timeout: 10_000 });
        const parkedHead = page.locator('h2', { hasText: 'Parked' });
        await parkedHead.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('01-approvals-two-parked-rows');

        const rows = page.locator('button', { hasText: 'locker.purge_item' });
        const rowCount = await rows.count();
        assert(rowCount === 2, `expected 2 parked locker.purge_item rows, got ${rowCount}`);

        const rowTexts = [];
        for (let i = 0; i < rowCount; i++) {
          rowTexts.push((await rows.nth(i).innerText()).replace(/\n/g, ' | '));
        }
        console.log(`[verify-appr] parked row texts: ${JSON.stringify(rowTexts)}`);

        const hasRawSlug = rowTexts.some((t) =>
          t.toLowerCase().includes(AGENT_AUTO_ID.toLowerCase()),
        );
        assert(
          !hasRawSlug,
          `a parked row still shows the raw automation slug "${AGENT_AUTO_ID}": ${JSON.stringify(rowTexts)}`,
        );

        // ParkedRow's chip is CSS text-transform:uppercase (KindBadge) --
        // innerText reflects the rendered (uppercased) text, not the DOM
        // literal "App"/"Automation", so match case-insensitively.
        const hasAppChip = rowTexts.some((t) => /\bapp\b/i.test(t) && /Locker/i.test(t));
        const hasAutomationChip = rowTexts.some((t) => /\bautomation\b/i.test(t));
        console.log(
          `[verify-appr] an "App" chip + "Locker" present on some row: ${hasAppChip}; an "Automation" chip present on some row: ${hasAutomationChip}`,
        );
        assert(
          hasAppChip,
          `expected one parked row to show an "App" chip next to "Locker": ${JSON.stringify(rowTexts)}`,
        );
        assert(
          hasAutomationChip,
          `expected one parked row to show an "Automation" chip: ${JSON.stringify(rowTexts)}`,
        );

        // Expand each row for a close-up screenshot of the badge + name.
        await rows.nth(0).click();
        await page.waitForTimeout(200);
        await shot('02-approvals-row1-expanded');
        await rows.nth(0).click();
        await page.waitForTimeout(150);
        await rows.nth(1).click();
        await page.waitForTimeout(200);
        await shot('03-approvals-row2-expanded');
      },
    );

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ VERIFY APPROVALS IDENTITY VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(30)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${String(r.error).split('\n')[0]}`);
    }
    console.log('===========================================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll verify-approvals-identity steps PASSED.');
    }
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
