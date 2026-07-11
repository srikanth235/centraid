#!/usr/bin/env node
// governance: allow-repo-hygiene file-size-limit (#363) single coherent multi-step live-app QA scenario against the real Electron+gateway rig; splitting mid-scenario would fragment one flow across files with no readability gain
// Automations CORNER CASES + consent-interplay QA suite: a confirm-gated
// Locker command (`purge_item`) invoked under a REAL automation's enrolled
// vault agent -> parks in Approvals just like an app caller; approve it and
// watch it execute; rapid-double Run now; disable mid-flight; delete with
// run history; Insights cross-check; failed-run rendering.
//
// HARNESS NOTES (carried over from flows-automations-01-lifecycle.mjs and
// flows-automations-02-triggers.mjs, read first -- this suite reuses their
// selector fixes verbatim):
//   - the enable switch is a visually-hidden `<input role="switch">` --
//     `waitFor({state:'attached'})` not 'visible', and click the `<label>`
//     wrapper (`label:has(input[role="switch"])`), not the 0x0 input.
//   - timeline node heads: `button[class*="tlHead"]` (must include the
//     `button` tag -- an unscoped `[class*="tlHead"]` also matches the inert
//     static final-card header div, whose class is "...tlHeadStatic...").
//   - `document.body.innerText` reflects CSS `text-transform: uppercase` on
//     some labels -- match body-text assertions case-insensitively.
//   - NEVER use a bare `[aria-expanded]` selector -- the sidebar's vault
//     switcher (ProfileSwitcherHead) always renders aria-expanded too, and
//     `.first()` on an unscoped locator silently grabs it instead of a real
//     target, popping the vault-switcher open and eating every subsequent
//     click for the rest of the run.
//   - console-error filters must check `msg.location().url` (`frameUrl`
//     here), never the message text, to identify the failing resource.
//   - out-of-band gateway fetch: `window.CentraidApi.getGatewayAuth()` +
//     a raw fetch, bypassing the UI (flows-automations-02-triggers.mjs).
//
// CONSENT-PARKING PATH (source-verified before writing this suite -- see
// the final report for file:line citations): "automations run as enrolled
// vault agents" is real end to end. `packages/gateway/src/serve/vault-
// plane.ts` `agentBridgeFor()` authenticates a fire's `ctx.vault` calls as
// `{kind:'agent', agentId, deviceId: boot.deviceId, deviceKey: boot.
// deviceKey}` (the automation's own `agent.agent` row riding the host's
// owner-device session). `packages/vault/src/gateway/gateway.ts` parks any
// `confirm:true` command for every non-owner-device identity, agents
// included -- so an automation invoking `locker.purge_item` parks exactly
// like an app caller. Rather than fabricate this out-of-band, this suite
// drives a REAL automation run: scaffold a throwaway automation (POST
// /centraid/_automations), overwrite its `handler.js` with real `ctx.vault`
// calls via the generic draft-file routes (`PUT /_apps/<id>/files/<rel>`,
// `POST /_apps/<id>/publish` -- packages/gateway/src/routes/apps-store-
// routes.ts), grant its agent schema access via the owner route (`POST
// /_vault/agents/<appId>/grants` -- packages/gateway/src/routes/vault-
// routes.ts:277-296, mirroring the Locker app's own "Grant access"), then
// click "Run now" for real in the UI. `ctx.vault.invoke(...)`'s wire
// convention (`{command, input, purpose}`, awaited to the raw gateway
// result) is copied verbatim from the shipped `doc-filer` and
// `doc-entity-linker` templates' own handler.js files.
//
// Run with: node apps/desktop/tests/e2e-live/flows-automations-03-corners.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-automations-03-corners');

const TEMPLATE_HEALTH = 'System health check';
const AGENT_AUTO_ID = 'e2e-agent-purge-demo';
const AGENT_AUTO_NAME = 'E2E agent purge demo';
const FAIL_AUTO_ID = 'e2e-fail-demo';
const FAIL_AUTO_NAME = 'E2E fail demo';
const LOCKER_TARGET_TITLE = 'automation target secret';
const PURPOSE = 'dpv:ServiceProvision';

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const results = [];
let page;
let session;
const consoleMessages = [];
const findings = [];

function note(msg) {
  findings.push(msg);
  console.log(`[auto03] FINDING: ${msg}`);
}

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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-auto03-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `auto03-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function bodyText() {
  return page.evaluate(() => document.body.textContent);
}

// ---- out-of-band gateway JSON fetch (owner-device auth, same pattern as
// flows-approvals-02-corner-cases.mjs / flows-automations-01/02.mjs) ----
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

/** Raw draft-file write -- PUT /_apps/<appId>/files/<rel>?sessionId=<id>
 *  with the file's literal text content as the body (route-helpers.ts's
 *  readBody, not readJson -- no JSON envelope). */
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

async function gwListAutomations() {
  const { json } = await gwFetch('/centraid/_automations');
  return json?.rows ?? [];
}

async function gwFindRef(name) {
  const rows = await gwListAutomations();
  const row = rows.find((r) => r.name === name);
  return row?.ref ?? null;
}

async function gwRuns(ref, limit = 50) {
  const { json } = await gwFetch(
    `/centraid/_automations/runs?ref=${encodeURIComponent(ref)}&limit=${limit}`,
  );
  return json?.runs ?? [];
}

async function gwBlocking() {
  const { json } = await gwFetch('/centraid/_vault/blocking');
  return json ?? {};
}

/**
 * Scaffold a throwaway automation app with a CUSTOM handler.js: (1) POST
 * /centraid/_automations with publish:false so the session stays open for
 * editing (lifecycle-shared.ts stageAndMaybePublish: "a staged draft must
 * keep its session so it stays previewable"), (2) PUT the handler.js draft
 * file, (3) POST /_apps/<id>/publish to go live in one shot.
 */
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
 *  (packages/gateway/src/routes/vault-routes.ts:277-296), the agent-plane
 *  mirror of the Locker app's own "Grant access" button. Enrolls the agent
 *  as a side effect if it wasn't already (vault-plane.ts approveAgentGrant
 *  -> ensureAgentEnrolled). */
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

async function openAutomationsOverview() {
  await navTo(page, 'Automations');
  await page
    .getByRole('heading', { name: 'Automations', level: 1 })
    .waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(300);
}

async function openAutomationView(name) {
  await openAutomationsOverview();
  const row = page.getByRole('button', { name: new RegExp(esc(name)) }).first();
  await row.waitFor({ state: 'visible', timeout: 10_000 });
  await row.click();
  await page
    .getByRole('heading', { name, level: 1 })
    .waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(200);
}

async function adoptTemplate(templateName) {
  await navTo(page, 'Discover');
  await page.getByRole('tab', { name: /^Automations/ }).click();
  await page.waitForTimeout(200);
  const card = page.locator('button[data-kind="automation"]', { hasText: templateName }).first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await card.click();
  const dialog = page.getByRole('dialog', { name: new RegExp(esc(templateName)) });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Use template' }).click();
  await page.getByRole('button', { name: 'Config' }).waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(500);
}

async function runNowFromViewScreen() {
  const runBtn = page.getByRole('button', { name: /Run now|Starting…/ });
  await runBtn.waitFor({ state: 'visible', timeout: 5_000 });
  await runBtn.click();
}

function frameLoc(p) {
  return p.frameLocator('iframe[data-centraid-app="1"]');
}

async function openLocker(p) {
  const sidebarItem = p.getByRole('button', { name: 'Locker', exact: true }).first();
  await sidebarItem.waitFor({ state: 'visible', timeout: 15_000 });
  await sidebarItem.click();
  await p.waitForSelector('iframe[data-centraid-app="1"]', { state: 'attached', timeout: 20_000 });
  const fl = frameLoc(p);
  await fl.locator('.v-newbtn').waitFor({ state: 'visible', timeout: 15_000 });
  return fl;
}

async function goApprovals(p) {
  await p
    .getByRole('button', { name: /^Approvals/ })
    .first()
    .click();
  await p
    .getByRole('heading', { name: 'Approvals', level: 1 })
    .waitFor({ state: 'visible', timeout: 10_000 });
}

/** ParkedRow's whole toggle surface is a <button> containing the command text. */
function parkedRowToggle(p, commandText, nth = 0) {
  return p.locator('button', { hasText: commandText }).nth(nth);
}

// The custom handler.js for AGENT_AUTO_ID: reads the vault as this
// automation's own enrolled agent to find a trashed Locker item, then
// invokes the confirm-gated purge_item command -- the exact
// automation-as-agent consent-parking path this flow exercises.
// `ctx.vault.invoke`/`ctx.vault.read`'s wire shape is copied from the
// shipped doc-filer/doc-entity-linker templates. Deliberately avoids every
// handler-lint-forbidden pattern (packages/automation/src/handler/lint.ts):
// no Date.now/new Date()/Math.random/fetch/fs.
const AGENT_PURGE_HANDLER_JS = `const PURPOSE = 'dpv:ServiceProvision';

/**
 * E2E harness handler (flows-automations-03-corners.mjs, flow2 "automation-
 * consent-parking"). Reads the vault as THIS automation's enrolled agent
 * to find a trashed Locker item, then invokes the confirm-gated
 * locker.purge_item command -- exercising the automation-as-agent
 * consent-parking path end to end (packages/vault/src/gateway/gateway.ts
 * ~637-669: any confirm:true command parks for every non-owner-device
 * caller, agents included).
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

// The custom handler.js for FAIL_AUTO_ID: throws unconditionally, for a
// cheap, deterministic failed run (flow8 "failed-run-rendering").
const FAIL_HANDLER_JS = `/**
 * E2E harness handler (flows-automations-03-corners.mjs, flow8
 * "failed-run-rendering"). Deliberately throws so Run now produces a real
 * failed run record to check the run-viewer's failure rendering.
 */
export default async ({ log }) => {
  log.info('about to fail deliberately');
  throw new Error('deliberate e2e failure for run-viewer rendering check');
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
  console.log(`[auto03] launched (fresh vault) + Home ready in ${Date.now() - t0}ms`);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    // -----------------------------------------------------------------
    // FLOW: setup
    // -----------------------------------------------------------------
    await step(
      'setup',
      'Adopt "System health check"; install Locker + grant access; create+trash a Locker item',
      async () => {
        await adoptTemplate(TEMPLATE_HEALTH);
        await shot('00-adopted-health-check');

        await navTo(page, 'Discover');
        const lockerCard = page.locator('button[data-kind="app"]', { hasText: 'Locker' }).first();
        await lockerCard.waitFor({ state: 'visible', timeout: 20_000 });
        await lockerCard.click();
        const dialog = page.getByRole('dialog', { name: /^Preview Locker/ });
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await dialog.getByRole('button', { name: 'Use this template' }).click();
        const toast = page.locator('[data-global-toast]');
        await toast.waitFor({ state: 'visible', timeout: 10_000 });

        const fl = await openLocker(page);
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
        const fl2 = await openLocker(page);
        await fl2.locator('.v-newbtn').click();
        const modal = fl2.locator('.kit-modal');
        await modal.waitFor({ state: 'visible', timeout: 8000 });
        await modal.locator('.v-in').first().fill(LOCKER_TARGET_TITLE);
        await modal.getByRole('button', { name: 'Save', exact: true }).click();
        await modal.waitFor({ state: 'hidden', timeout: 8000 });
        await fl2.locator('.v-item', { hasText: LOCKER_TARGET_TITLE }).click();
        const detail = fl2.locator('.v-detail-inner');
        await detail.waitFor({ state: 'visible', timeout: 8000 });
        await detail.getByRole('button', { name: 'Move to trash' }).click();
        await fl2.locator('.v-list').waitFor({ state: 'visible', timeout: 8000 });
        await fl2.locator('button.v-nav-item', { hasText: 'Trash' }).click();
        // Observed flake: the Trash tab occasionally paints before the
        // client-side item list has refreshed post-move (nav badge shows 0,
        // "All items"/"Logins" still counted the item live) -- a real race
        // in the app, not just a slow screenshot. Poll instead of a fixed
        // wait so a slightly-slower refresh doesn't fail the setup outright.
        let trashedCount = 0;
        const trashDeadline = Date.now() + 8_000;
        while (Date.now() < trashDeadline) {
          trashedCount = await fl2.locator('.v-item', { hasText: LOCKER_TARGET_TITLE }).count();
          if (trashedCount === 1) break;
          await page.waitForTimeout(400);
        }
        if (trashedCount !== 1) {
          note(
            `Locker's Trash tab took >8s (or never) to reflect a just-trashed item after "Move to trash" -- observed once as an ` +
              `immediate-refresh race (Trash nav badge showed 0, "All items"/"Logins" counts still included the item live, Trash list ` +
              `said "Nothing here.") on an earlier run of this suite. See auto03-01-locker-item-trashed.png for the eventual state.`,
          );
        }
        assert(
          trashedCount === 1,
          `expected "${LOCKER_TARGET_TITLE}" trashed once, got ${trashedCount}`,
        );
        await shot('01-locker-item-trashed');
      },
    );

    // -----------------------------------------------------------------
    // FLOW: automation-consent-parking
    // -----------------------------------------------------------------
    let parkedInvocationId = null;
    let parkedCallerLabel = null;
    await step(
      'automation-consent-parking',
      'Scaffold a real automation, grant its agent Locker access, Run now -> locker.purge_item parks under the AUTOMATION AGENT identity',
      async () => {
        await scaffoldCustomAutomation({
          id: AGENT_AUTO_ID,
          name: AGENT_AUTO_NAME,
          handlerJs: AGENT_PURGE_HANDLER_JS,
        });
        const grantId = await approveAgentGrant(AGENT_AUTO_ID, [
          { schema: 'locker', verbs: 'read+act' },
        ]);
        console.log(
          `[auto03] approved agent grant ${grantId} for "${AGENT_AUTO_ID}" (schema locker, read+act)`,
        );

        const agentsRes = await gwFetch('/centraid/_vault/agents');
        console.log(`[auto03] GET /_vault/agents after grant: ${JSON.stringify(agentsRes.json)}`);
        // Agent display names now resolve to the automation's real manifest
        // name (reconcileScheduler threads it through enrollAutomationAgent),
        // not the raw appId slug -- see the parked-caller-identity fix below.
        const agentRow = (agentsRes.json?.agents ?? []).find((a) => a.name === AGENT_AUTO_NAME);
        assert(Boolean(agentRow), `expected an enrolled agent named "${AGENT_AUTO_NAME}"`);

        await openAutomationView(AGENT_AUTO_NAME);
        await shot('02-agent-purge-automation-view');
        await runNowFromViewScreen();
        await page.waitForTimeout(1000);
        await shot('03-agent-purge-run-view-after-click');

        // The park is a synchronous in-memory write inside ctx.vault.invoke
        // (gateway.ts's `this.parked.set(...)`), landing well before the
        // handler returns or the run resolves -- poll the owner blocking
        // feed directly rather than waiting on the run viewer.
        const deadline = Date.now() + 30_000;
        let parked = null;
        while (Date.now() < deadline) {
          const blocking = await gwBlocking();
          parked = (blocking.parked ?? []).find((p) => p.command === 'locker.purge_item');
          if (parked) break;
          await page.waitForTimeout(700);
        }
        console.log(`[auto03] parked entry found: ${JSON.stringify(parked)}`);
        assert(
          Boolean(parked),
          'expected a parked locker.purge_item invocation within 30s of Run now',
        );
        assert(
          parked.callerKind === 'agent',
          `expected callerKind "agent", got ${JSON.stringify(parked.callerKind)}`,
        );
        parkedInvocationId = parked.invocationId;
        parkedCallerLabel = parked.caller;
        note(
          `GET /_vault/blocking's parked entry shows callerKind="${parked.callerKind}" caller=${JSON.stringify(parked.caller)} -- ` +
            `"caller" now resolves to the automation's real manifest name ("${AGENT_AUTO_NAME}") and the Approvals row carries an ` +
            `explicit App/Automation/Assistant kind badge (fixed this session: reconcileScheduler threads the manifest name through ` +
            `enrollAutomationAgent, packages/gateway/src/serve/build-gateway.ts / vault-plane.ts; ParkedRow renders a KindBadge, ` +
            `apps/desktop/src/renderer/react/screens/ApprovalsScreen.tsx).`,
        );

        await goApprovals(page);
        await shot('04-approvals-with-agent-parked-row');
        // The Approvals PAGE itself (fetched fresh on navigation) already
        // shows the park correctly ("1 waiting on you" + a "Parked 1"
        // group) -- assert on that first. The SIDEBAR badge is a distinct,
        // separately-fetched surface that only refreshes on its own
        // decisions or a window `focus` event (issue #306 decision 5,
        // confirmed empirically in flows-approvals-02-corner-cases.mjs
        // flow6) -- an automation-sourced park (no user gesture inside
        // Approvals) is exactly the case that lags, so dispatch focus
        // before checking it, matching that suite's pattern.
        const subtitle = await page.locator('text=waiting on you').first().textContent();
        console.log(`[auto03] Approvals page subtitle: ${JSON.stringify(subtitle)}`);
        assert(
          /1 waiting on you/.test(subtitle ?? ''),
          `expected the Approvals page subtitle to read "1 waiting on you", got ${JSON.stringify(subtitle)}`,
        );

        const badgeBeforeFocus = await page
          .getByRole('button', { name: /^Approvals/ })
          .first()
          .textContent();
        console.log(
          `[auto03] sidebar Approvals badge BEFORE a focus event (expected to lag for a background-sourced park): ${JSON.stringify(badgeBeforeFocus)}`,
        );
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await page.waitForTimeout(600);
        const badgeAfterFocus = await page
          .getByRole('button', { name: /^Approvals/ })
          .first()
          .textContent();
        console.log(
          `[auto03] sidebar Approvals badge AFTER a focus event: ${JSON.stringify(badgeAfterFocus)}`,
        );
        assert(
          /Approvals1/.test(badgeAfterFocus ?? ''),
          `expected the sidebar badge to catch up to "Approvals1" after a focus event, got ${JSON.stringify(badgeAfterFocus)}`,
        );
        note(
          `sidebar Approvals badge for an automation-sourced (background) park: BEFORE focus=${JSON.stringify(badgeBeforeFocus)}, ` +
            `AFTER focus=${JSON.stringify(badgeAfterFocus)} -- confirms the known badge-lag behavior (issue #306 decision 5) also applies ` +
            `to automation-driven parks, not just app-driven ones; the Approvals PAGE's own subtitle is correct immediately, only the sidebar chip lags.`,
        );

        const row = parkedRowToggle(page, 'locker.purge_item', 0);
        await row.waitFor({ state: 'visible', timeout: 10_000 });
        const rowText = await row.textContent();
        console.log(
          `[auto03] Parked row text (what the owner actually sees): ${JSON.stringify(rowText.replace(/\n/g, ' | '))}`,
        );
        await row.click();
        await page.waitForTimeout(300);
        await shot('05-approvals-agent-parked-row-expanded');
        const pre = page.locator('pre').first();
        const preText = await pre.textContent().catch(() => '');
        console.log(`[auto03] expanded parked row input preview: ${preText}`);
        assert(
          /item_id/.test(preText ?? ''),
          `expected item_id in the raw input preview, got: ${preText}`,
        );
      },
    );

    // -----------------------------------------------------------------
    // FLOW: approve-parked-automation-action
    // -----------------------------------------------------------------
    await step(
      'approve-parked-automation-action',
      'Approve the automation-sourced parked invocation -> executes for real, item purged in Locker',
      async () => {
        await goApprovals(page);
        const row = parkedRowToggle(page, 'locker.purge_item', 0);
        await row.waitFor({ state: 'visible', timeout: 10_000 });
        // The previous flow left this same row EXPANDED (it clicked once to
        // read the JSON preview and never collapsed it back) -- Approvals is
        // the same mounted route both times, so ParkedRow's local
        // `expandedParked` state survives the sidebar re-click and a second
        // unconditional `row.click()` here would TOGGLE IT CLOSED instead of
        // opening it (confirmed: this is exactly what produced the first
        // "Approve" button timeout on this suite). Only click to expand when
        // the action buttons aren't already visible.
        const approveBtn = page.getByRole('button', { name: 'Approve', exact: true });
        if (!(await approveBtn.isVisible().catch(() => false))) {
          await row.click();
          await page.waitForTimeout(200);
        }
        await approveBtn.click();
        await page.waitForTimeout(800);
        await shot('06-approvals-after-approve');
        const remaining = await page.locator('button', { hasText: 'locker.purge_item' }).count();
        console.log(
          `[auto03] "locker.purge_item" parked rows remaining after approve: ${remaining}`,
        );
        assert(
          remaining === 0,
          `expected the parked row to be gone after approve, got ${remaining} remaining`,
        );

        const fl = await openLocker(page);
        await fl.locator('button.v-nav-item', { hasText: 'Trash' }).click();
        await page.waitForTimeout(400);
        const stillThere = await fl.locator('.v-item', { hasText: LOCKER_TARGET_TITLE }).count();
        console.log(
          `[auto03] "${LOCKER_TARGET_TITLE}" still in Locker trash after approve: ${stillThere}`,
        );
        assert(
          stillThere === 0,
          `expected "${LOCKER_TARGET_TITLE}" to be purged for real after approval, found ${stillThere}`,
        );
        await shot('07-locker-trash-target-purged');
        console.log(
          `[auto03] confirmed: invocation ${parkedInvocationId} (caller="${parkedCallerLabel}") executed for real on approval`,
        );
      },
    );

    // -----------------------------------------------------------------
    // FLOW: rapid-double-run-now
    // -----------------------------------------------------------------
    await step(
      'rapid-double-run-now',
      'System health check: click Run now twice as fast as possible -> no crash, document actual run count',
      async () => {
        await openAutomationView(TEMPLATE_HEALTH);
        const before = (await gwRuns(await gwFindRef(TEMPLATE_HEALTH))).length;
        console.log(`[auto03] run count before rapid double-click: ${before}`);
        const runBtn = page.getByRole('button', { name: /Run now|Starting…/ });
        await runBtn.waitFor({ state: 'visible', timeout: 5_000 });
        await Promise.all([runBtn.click(), runBtn.click().catch(() => undefined)]);
        await page.waitForTimeout(3000);
        await shot('08-after-rapid-double-run-now');
        const crashed = await page.evaluate(() => document.title).catch(() => null);
        assert(crashed !== null, 'page appears to have crashed after rapid double-click Run now');

        const ref = await gwFindRef(TEMPLATE_HEALTH);
        const runsAfter = await gwRuns(ref);
        console.log(
          `[auto03] run count after rapid double-click: ${runsAfter.length} (delta ${runsAfter.length - before})`,
        );
        assert(
          runsAfter.length - before >= 1,
          `expected at least 1 new run from the double-click, got delta ${runsAfter.length - before}`,
        );
        assert(
          runsAfter.length - before <= 2,
          `expected AT MOST 2 new runs from a double-click (no runaway duplication), got delta ${runsAfter.length - before}`,
        );
        note(
          `rapid double-click "Run now" on ${TEMPLATE_HEALTH} produced ${runsAfter.length - before} new run(s) (before=${before}, after=${runsAfter.length}) -- ` +
            `${runsAfter.length - before === 2 ? 'both clicks fired their own run (queued/sequential), which the brief treats as acceptable' : 'the second click was effectively debounced/ignored'}. No crash, no stuck spinner.`,
        );
        const errorsSoFar = consoleMessages.filter((m) => m.type === 'error');
        assert(
          errorsSoFar.length === 0,
          `expected no console errors from rapid double-click, got: ${JSON.stringify(errorsSoFar)}`,
        );
      },
    );

    // -----------------------------------------------------------------
    // FLOW: disable-during-run
    // -----------------------------------------------------------------
    await step(
      'disable-during-run',
      'Start Run now (real UI click), immediately disable while in flight -> run settles gracefully, automation stays disabled',
      async () => {
        await openAutomationView(TEMPLATE_HEALTH);
        const sw = page.locator('input[role="switch"]');
        await sw.waitFor({ state: 'attached', timeout: 5_000 });
        const switchLabel = page.locator('label:has(input[role="switch"])');
        const before = await sw.getAttribute('aria-checked');
        console.log(`[auto03] switch state entering disable-during-run: aria-checked=${before}`);
        // Start from an ENABLED automation so "ends up disabled" is a real
        // transition, not a no-op against an already-disabled default.
        if (before !== 'true') {
          await switchLabel.click({ timeout: 5_000 });
          await page.waitForTimeout(500);
          assert(
            (await sw.getAttribute('aria-checked')) === 'true',
            'failed to pre-enable the automation for this flow',
          );
        }

        const ref = await gwFindRef(TEMPLATE_HEALTH);
        const runsBefore = await gwRuns(ref);

        const runBtn = page.getByRole('button', { name: /Run now|Starting…/ });
        await runBtn.waitFor({ state: 'visible', timeout: 5_000 });
        await runBtn.click();
        // Clicking "Run now" navigates the renderer to the run-view screen
        // almost immediately (confirmed empirically: the automation view's
        // enable-switch label routinely goes stale/detached before a second
        // Playwright command can act on it -- a `label.click()` here
        // reliably timed out on an earlier pass of this suite, and because
        // the automation had started disabled by default, that swallowed
        // failure produced a FALSE PASS: the assertion "ends up disabled"
        // trivially held even though the toggle click never landed). A
        // disable during an in-flight run is realistically multi-surface
        // anyway (another device, the CLI, Settings) -- exercise it the
        // same way: fire the run for real via the UI, then race a genuine
        // concurrent disable in over the wire, same as a second actor would.
        const disableRes = await gwFetch(
          `/centraid/_automations/set-enabled?ref=${encodeURIComponent(ref)}`,
          {
            method: 'POST',
            body: { enabled: false, publish: true },
          },
        );
        console.log(`[auto03] concurrent disable while run in flight: status=${disableRes.status}`);
        assert(
          disableRes.status === 200,
          `expected the concurrent disable to succeed, got ${JSON.stringify(disableRes)}`,
        );
        await page.waitForTimeout(1500);
        await shot('09-disable-during-run-immediately-after');

        // The in-flight run must resolve, not hang forever.
        const deadline = Date.now() + 20_000;
        let runsAfter = [];
        while (Date.now() < deadline) {
          runsAfter = await gwRuns(ref);
          if (runsAfter.length > runsBefore.length) break;
          await page.waitForTimeout(700);
        }
        console.log(
          `[auto03] runs before=${runsBefore.length} after=${runsAfter.length}: latest=${JSON.stringify(runsAfter[0])}`,
        );
        assert(
          runsAfter.length > runsBefore.length,
          'expected the in-flight run to land a run record, not vanish/hang',
        );
        assert(
          typeof runsAfter[0]?.endedAt === 'number',
          `expected the in-flight run to have ended, got ${JSON.stringify(runsAfter[0])}`,
        );

        await openAutomationView(TEMPLATE_HEALTH);
        const sw2 = page.locator('input[role="switch"]');
        await sw2.waitFor({ state: 'attached', timeout: 5_000 });
        const after = await sw2.getAttribute('aria-checked');
        console.log(`[auto03] switch state after in-flight disable + renav: aria-checked=${after}`);
        await shot('10-disable-during-run-automation-view-after');
        assert(
          after === 'false',
          `expected the UI switch to reflect the concurrent disable after renav, got aria-checked=${after}`,
        );

        const { json } = await gwFetch(
          `/centraid/_automations/read?ref=${encodeURIComponent(ref)}`,
        );
        console.log(
          `[auto03] gateway row enabled state after in-flight disable: ${json?.row?.enabled}`,
        );
        assert(
          json?.row?.enabled === false,
          `expected the automation to end up disabled, got enabled=${JSON.stringify(json?.row?.enabled)}`,
        );

        const errorsSoFar = consoleMessages.filter((m) => m.type === 'error');
        console.log(`[auto03] console errors after disable-during-run: ${errorsSoFar.length}`);
      },
    );

    // -----------------------------------------------------------------
    // FLOW: delete-with-run-history-safety
    // -----------------------------------------------------------------
    await step(
      'delete-with-run-history-safety',
      'Delete System health check (which has run history) -> confirm modal -> no crash; orphaned recent-run rows do not break the overview',
      async () => {
        await openAutomationView(TEMPLATE_HEALTH);
        const deleteBtn = page.getByRole('button', {
          name: `Delete ${TEMPLATE_HEALTH}`,
          exact: true,
        });
        await deleteBtn.waitFor({ state: 'visible', timeout: 5_000 });
        await deleteBtn.click();
        const dialog = page.getByRole('dialog', { name: 'Delete automation?' });
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('11-delete-confirm-dialog');
        await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
        await page.waitForTimeout(800);
        await page
          .getByRole('heading', { name: 'Automations', level: 1 })
          .waitFor({ state: 'visible', timeout: 10_000 });
        await shot('12-overview-after-delete');

        const ovGone = await page
          .getByRole('button', { name: new RegExp(esc(TEMPLATE_HEALTH)) })
          .count();
        assert(
          ovGone === 0,
          `expected 0 overview rows for "${TEMPLATE_HEALTH}" after delete, found ${ovGone}`,
        );

        const crashed = await page.evaluate(() => document.title).catch(() => null);
        assert(
          crashed !== null,
          'page appears to have crashed after deleting an automation with run history',
        );

        // The global "Recent runs" feed on the overview screen may still
        // list orphaned rows for the deleted automation (AutomationsOverviewScreen.tsx
        // RunRow, `button[class*="auOvRun"]` / data-ok). Try clicking one --
        // must not crash, even if it 404s or shows an error state.
        const orphanRuns = page.locator('button[class*="auOvRun"]');
        const orphanCount = await orphanRuns.count();
        console.log(
          `[auto03] "Recent runs" rows visible on the overview after delete: ${orphanCount}`,
        );
        if (orphanCount > 0) {
          const rowText = await orphanRuns
            .first()
            .textContent()
            .catch(() => '');
          console.log(
            `[auto03] first recent-run row text after delete: ${JSON.stringify(rowText.replace(/\n/g, ' | '))}`,
          );
          await orphanRuns.first().click();
          await page.waitForTimeout(1000);
          await shot('13-clicked-orphaned-recent-run-row');
          const crashedAfterClick = await page.evaluate(() => document.title).catch(() => null);
          assert(
            crashedAfterClick !== null,
            'page appears to have crashed after clicking an orphaned recent-run row',
          );
          note(
            `after deleting "${TEMPLATE_HEALTH}" (which had run history), the overview's global "Recent runs" feed still listed ` +
              `${orphanCount} row(s) referencing it; clicking the first one did not crash the app (see auto03-13-clicked-orphaned-recent-run-row.png).`,
          );
          // Navigate back to a known-good screen for the next flow.
          await openAutomationsOverview();
        } else {
          note(
            `after deleting "${TEMPLATE_HEALTH}", the overview's "Recent runs" feed showed 0 rows (orphaned runs were not surfaced there).`,
          );
        }
      },
    );

    // -----------------------------------------------------------------
    // FLOW: insights-cross-check
    // -----------------------------------------------------------------
    await step(
      'insights-cross-check',
      "Insights shows this session's automation runs, attributed by real automation display name (regression check on last session's fix)",
      async () => {
        await navTo(page, 'Insights');
        await page
          .getByRole('heading', { name: 'Insights', level: 1 })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForTimeout(800);
        await shot('14-insights-after-session');

        const bodyTxt = await bodyText();
        console.log(
          `[auto03] Insights body (first 900 chars): ${bodyTxt.slice(0, 900).replace(/\n/g, ' | ')}`,
        );

        const hasAgentAutoName = bodyTxt.includes(AGENT_AUTO_NAME);
        const hasHealthCheckName = bodyTxt.includes(TEMPLATE_HEALTH);
        const hasGenericAutomationOnly = /\bAutomation\b/.test(bodyTxt);
        console.log(
          `[auto03] Insights shows "${AGENT_AUTO_NAME}" by name: ${hasAgentAutoName}; shows "${TEMPLATE_HEALTH}" by name (even though it's deleted): ${hasHealthCheckName}; generic "Automation" tag present: ${hasGenericAutomationOnly}`,
        );
        assert(
          hasAgentAutoName || hasHealthCheckName,
          'expected at least one real automation display name to appear on Insights, not just a generic "Automation" label',
        );
        note(
          `Insights display-name regression check: "${AGENT_AUTO_NAME}" shown=${hasAgentAutoName}, deleted "${TEMPLATE_HEALTH}" still shown by name=${hasHealthCheckName}.`,
        );
      },
    );

    // -----------------------------------------------------------------
    // FLOW: failed-run-rendering
    // -----------------------------------------------------------------
    await step(
      'failed-run-rendering',
      'A deliberately-throwing automation -> run viewer renders the failure state legibly (data-status="fail", visible error, no blank panel)',
      async () => {
        await scaffoldCustomAutomation({
          id: FAIL_AUTO_ID,
          name: FAIL_AUTO_NAME,
          handlerJs: FAIL_HANDLER_JS,
        });
        await openAutomationView(FAIL_AUTO_NAME);
        await shot('15-fail-demo-view-before-run');
        await runNowFromViewScreen();
        await shot('16-fail-demo-run-view-after-click');

        const deadline = Date.now() + 30_000;
        let finalStatus = 'pending';
        while (Date.now() < deadline) {
          const nodes = page.locator('[data-status]');
          const n = await nodes.count();
          if (n > 0) {
            finalStatus = await nodes.last().getAttribute('data-status');
            if (finalStatus === 'ok' || finalStatus === 'fail') break;
          }
          await page.waitForTimeout(700);
        }
        console.log(`[auto03] fail-demo final timeline node data-status: ${finalStatus}`);
        await shot('17-fail-demo-run-view-settled');
        assert(
          finalStatus === 'fail',
          `expected the deliberately-throwing handler to resolve data-status="fail", got ${finalStatus}`,
        );

        const bodyTxt = await bodyText();
        const hasRunFailed = /run failed/i.test(bodyTxt);
        const hasErrorText = /deliberate e2e failure/i.test(bodyTxt);
        console.log(
          `[auto03] "Run failed" text visible: ${hasRunFailed}; deliberate error message visible: ${hasErrorText}`,
        );
        assert(
          hasRunFailed,
          'expected "Run failed" text visible on the run viewer for a failed run',
        );
        const panelEmpty = bodyTxt.trim().length < 40;
        assert(
          !panelEmpty,
          `run viewer looks blank for a failed run (body text length ${bodyTxt.trim().length})`,
        );
        note(
          `failed-run rendering: data-status="fail" ✓, "Run failed" text visible=${hasRunFailed}, the actual thrown error message surfaced in the UI=${hasErrorText}.`,
        );
      },
    );

    // -----------------------------------------------------------------
    // FLOW: console-sweep
    // -----------------------------------------------------------------
    await step(
      'console-sweep',
      'Zero unexpected console errors across the whole suite',
      async () => {
        const allErrors = consoleMessages.filter((m) => m.type === 'error');
        for (const e of allErrors) console.log(`  CONSOLE ERROR: ${e.text} (${e.frameUrl})`);
        assert(
          allErrors.length === 0,
          `expected 0 console errors across the suite, got ${allErrors.length}: ${JSON.stringify(allErrors.map((e) => e.text))}`,
        );
      },
    );

    // -----------------------------------------------------------------
    // Report
    // -----------------------------------------------------------------
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ AUTOMATIONS CORNER-CASES VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(34)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${String(r.error).split('\n')[0]}`);
    }
    console.log('==========================================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);
    console.log(`Console warnings: ${consoleMessages.filter((m) => m.type === 'warning').length}`);
    console.log('\n---- FINDINGS ----');
    for (const f of findings) console.log(`- ${f}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll automations-corner-cases steps PASSED.');
    }
  } finally {
    await session.close();
    // Deliberately keep USER_DATA_DIR (not rm'd) for cross-referencing
    // screenshots/logs against the on-disk vault after the run.
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
