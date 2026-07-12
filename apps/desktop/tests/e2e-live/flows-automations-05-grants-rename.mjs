#!/usr/bin/env node
// governance: allow-repo-hygiene file-size-limit (#363) single coherent multi-step live-app QA scenario against the real Electron+gateway rig; splitting mid-scenario would fragment one flow across files with no readability gain
// Automations GRANTS + RENAME suite: this session added real-manifest-name
// enrollment for automation agents (reconcileScheduler -> enrollAutomationAgent
// AND approveAgentGrant -> resolveAutomationName, packages/gateway/src/serve/
// build-gateway.ts + vault-plane.ts, with packages/vault/src/host.ts's
// ensureAgentEnrolled changed so a name-less touch never downgrades an
// already-good name). This suite tests the edges of that: does a RENAME
// propagate everywhere; what happens to a PARKED invocation's displayed
// caller name when its automation is renamed mid-flight; what happens when
// the owner REVOKES a grant while an invocation is parked under it; and does
// a RE-GRANT afterward fully recover.
//
// SOURCE-VERIFIED FACTS this suite relies on (read before touching
// assertions):
//   - packages/automation/src/scaffold/app.ts:153-192 `list()` reads every
//     automation's DISPLAY NAME live off `automations/<id>/automation.json`'s
//     `name` field on disk (via `readAppAt` -> `parseManifest`) — there is no
//     separate name column anywhere; "the name" IS whatever that file
//     currently says. `ref = "<ownerApp>/<automationId>"` (formatRef).
//   - UPDATED for the Automations UI revamp (this lane's pass): a rename now
//     DOES have a real, primary UI mechanism -- AutomationEditorScreen.tsx's
//     "Name" field + "Save changes", which POSTs to the new dedicated
//     `POST /centraid/_automations/update?ref=` route (handleAutomationUpdate,
//     packages/gateway/src/routes/lifecycle-automation-routes.ts) via
//     `updateAutomation()` (gateway-client-editing.ts). Flow 1 below
//     (`rename-propagates-everywhere`) drives that real editor path end to
//     end. Flow 2 (`rename-mid-parked-invocation`) still renames
//     out-of-band -- not because no UI exists, but because that flow
//     specifically needs the Approvals screen to stay mounted with NO
//     renderer navigation across the rename (see
//     `renameAutomationViaUpdateEndpoint`'s doc comment) -- so it calls the
//     SAME update endpoint directly instead of clicking through the editor.
//     The old builder-chat rename path (a real LLM turn) still exists too,
//     but is non-deterministic/slow and isn't exercised here.
//   - packages/gateway/src/routes/apps-store-routes.ts `handlePublish` calls
//     `onAppLive?.(appId)`, which build-gateway.ts wires to
//     `reconcileScheduler(vaultId)` — so a rename-then-publish re-runs
//     `enrollAutomationAgent(appId, newName)` immediately, same tick.
//   - packages/vault/src/host.ts:413-453 `ensureAgentEnrolled` — when the
//     caller passes `options.displayName` (reconcileScheduler and
//     approveAgentGrant both do), an EXISTING agent's `core_party.
//     display_name` is overwritten to the new name even if it already had a
//     real name (`mayOverwrite = options.displayName !== undefined`). A
//     name-less touch may only self-heal a literal raw-slug legacy name.
//   - packages/vault/src/gateway/gateway.ts:1196-1244 `listParked()` /
//     `callerName()` — the `caller` string shown for a PARKED invocation is
//     computed LIVE on every `GET /_vault/blocking` / `GET /_vault/parked`
//     call, by joining `agent_agent -> core_party.display_name` on the
//     identity's `callerId` — it is NOT a value snapshotted at park time.
//     PREDICTION (verified below): renaming an automation with an
//     already-parked invocation should update what the Approvals row shows
//     for that SAME invocation immediately, because the join re-resolves the
//     current `display_name` every read.
//   - apps/desktop/src/renderer/react/shell/routes/InsightsRoute.tsx:22-34 —
//     the Insights "By source" panel's `label` is ALSO resolved live: the
//     gateway's `run_summary` table stores no name at all (packages/
//     app-engine/src/insights/insights-store.ts:149-156, "name is NULL here
//     ... the desktop resolves it from the app manifest") — InsightsRoute
//     fetches `listAutomations()` fresh on every load and maps `automation_
//     ref -> current name`. A rename should therefore also propagate to
//     Insights immediately, even for runs recorded before the rename.
//   - packages/vault/src/gateway/gateway.ts:756-777 `revokeGrant` ->
//     `revokeGrantCascade` — the revoke callback walks `this.parked` and, for
//     every parked entry whose `grantId` matches the revoked grant, DELETES
//     it from the in-memory parked map AND calls `setInvocationStatus(...,
//     'failed')`. This is a clean, designed cascade: revoking a grant drops
//     any invocation parked under it, marking it failed — not a silent
//     execute-without-a-live-grant, and not an unapprovable-forever ghost
//     row (a POST /_vault/parked/<id> against a gone id 404s cleanly,
//     vault-routes.ts:561-578).
//   - The parked entry's `grantId` is `consent.grantId` from `evaluateConsent`
//     at park time (gateway.ts:616-664) — the SAME id `approveAgentGrant`
//     returned when the owner granted the automation's agent access, so this
//     suite reuses that id directly rather than re-deriving it from `GET
//     /_vault/agents`.
//   - Approvals' own "Standing grants" section (ApprovalsScreen.tsx
//     `GrantRow`/`onRevokeGrant`) is wired to `listOutboxGrants()` /
//     `revokeOutboxGrant` (ApprovalsRoute.tsx) — OUTBOX "always allow" rules,
//     a completely different grant family from an automation agent's vault
//     schema grant (`POST /_vault/agents/<appId>/grants` / `DELETE /_vault/
//     grants/<grantId>`). Grepping the whole renderer confirms NO UI surface
//     anywhere lists or revokes an automation agent's schema grant — this
//     suite uses the owner API directly (`DELETE /centraid/_vault/grants/
//     <grantId>`, vault-routes.ts:320-330), exactly per the task brief.
//
// HARNESS NOTES carried over verbatim from suites 01-04 (read first):
//   - the enable switch is a visually-hidden `<input role="switch">` --
//     `waitFor({state:'attached'})` not 'visible', click the `<label>`
//     wrapper, not the 0x0 input.
//   - timeline node heads: `button[class*="tlHead"]`.
//   - `document.body.innerText` is CSS-uppercased on some labels -- match
//     case-insensitively.
//   - console-error filters must check `msg.location().url` (frameUrl),
//     never the message text.
//   - NEVER use a bare `[aria-expanded]` selector.
//   - openLocker() uses the sidebar's named button, not `[data-app-id]`.
//   - Approvals sidebar badge lags until a `focus` event.
//
// Run with: node apps/desktop/tests/e2e-live/flows-automations-05-grants-rename.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-automations-05-grants-rename');

const TEMPLATE_HEALTH = 'Trip albums';
const RENAMED_HEALTH = 'Vitals watch (renamed)';

const AGENT_ID = 'e2e-agent-rename-demo';
const AGENT_NAME = 'E2E agent rename demo';
const RENAMED_AGENT_NAME = 'E2E rename demo (renamed mid-park)';
const LOCKER_TARGET_TITLE = 'auto05 rename target secret';
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
  console.log(`[auto05] FINDING: ${msg}`);
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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-auto05-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `auto05-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function bodyText() {
  return page.evaluate(() => document.body.textContent);
}

// ---- out-of-band gateway JSON fetch (owner-device auth, same pattern as
// flows-automations-01/02/03/04.mjs) ----
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
 *  readBody, not readJson -- no JSON envelope). Mirrors suites 03/04. */
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

async function getDraftFile(appId, sessionId, rel) {
  const res = await gwFetch(
    `/centraid/_apps/${encodeURIComponent(appId)}/files?sessionId=${encodeURIComponent(sessionId)}`,
  );
  assert(res.status === 200, `GET draft files for "${appId}" failed: ${JSON.stringify(res)}`);
  const files = res.json?.files ?? [];
  const file = files.find((f) => f.path === rel);
  assert(
    Boolean(file),
    `draft file "${rel}" not found for "${appId}"; available: ${JSON.stringify(files.map((f) => f.path))}`,
  );
  return file.content;
}

/**
 * Rename an automation over the SAME `POST /centraid/_automations/update`
 * endpoint the editor's "Save changes" now calls (see
 * `renameAutomationViaEditor` above) -- but out-of-band, with NO renderer
 * navigation. Flow 2 below deliberately needs the Approvals screen to stay
 * mounted, untouched, across the rename (it's specifically testing what an
 * already-open Approvals row shows with no remount vs. a fresh look) --
 * driving the rename through the editor UI would force a navigate-away
 * (Automations -> Thread -> Editor -> Thread) that destroys that premise.
 * This keeps the real, current rename MECHANISM (the update endpoint, not
 * the old draft-file-write-then-publish primitive) while leaving the
 * renderer's Approvals mount alone.
 */
async function renameAutomationViaUpdateEndpoint(ref, newName) {
  const res = await gwFetch(`/centraid/_automations/update?ref=${encodeURIComponent(ref)}`, {
    method: 'POST',
    body: { name: newName, publish: true },
  });
  assert(res.status === 200, `update rename failed: ${JSON.stringify(res)}`);
  console.log(
    `[auto05] renamed ref="${ref}" -> "${newName}" via POST /_automations/update (out-of-band, same endpoint the editor's "Save changes" now calls; no renderer navigation, so Approvals stays mounted)`,
  );
  return res.json;
}

function splitRef(ref) {
  const idx = ref.indexOf('/');
  assert(idx > 0, `unexpected ref shape (no "/"): ${ref}`);
  return { appId: ref.slice(0, idx), automationId: ref.slice(idx + 1) };
}

/**
 * Rename an EXISTING automation through the REAL editor UI (Automations UI
 * revamp): Thread "Edit" -> AutomationEditorScreen.tsx's "Name" field ->
 * "Save changes", which now goes over the new dedicated
 * `POST /centraid/_automations/update` endpoint (AutomationEditorRoute.tsx
 * onSave -> updateAutomation, packages/gateway/src/routes/
 * lifecycle-automation-routes.ts handleAutomationUpdate) rather than the
 * old out-of-band draft-file-write-then-publish this suite used before this
 * session's editor landed. Only the name changes -- `instructions` is left
 * exactly as loaded (so `changed` stays false and no "Recompile plan"
 * affordance or handler-recompile side effect fires), and the trigger the
 * form loaded is resubmitted unmodified.
 */
async function renameAutomationViaEditor(oldName, newName) {
  await openAutomationView(oldName);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const nameInput = page.getByPlaceholder('Untitled automation');
  await nameInput.waitFor({ state: 'visible', timeout: 10_000 });
  // loadData() is async -- wait for the field to actually populate with the
  // OLD name before editing it, so this doesn't race the initial fetch and
  // clobber an empty draft with a save.
  const deadline = Date.now() + 10_000;
  let val = '';
  while (Date.now() < deadline) {
    val = await nameInput.inputValue();
    if (val === oldName) break;
    await page.waitForTimeout(200);
  }
  assert(
    val === oldName,
    `editor Name field never loaded "${oldName}" before timeout (stuck at ${JSON.stringify(val)})`,
  );
  await nameInput.fill(newName);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  const toast = page.locator('[data-global-toast]');
  await toast.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(300);
  // Back to the thread via the editor's own "Cancel" (routes to
  // automation-view for the same ref -- AutomationEditorRoute.tsx onCancel).
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page
    .getByRole('heading', { name: newName, level: 1 })
    .waitFor({ state: 'visible', timeout: 10_000 });
  console.log(`[auto05] renamed "${oldName}" -> "${newName}" via the editor UI`);
  return { oldName };
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

async function gwBlocking() {
  const { json } = await gwFetch('/centraid/_vault/blocking');
  return json ?? {};
}

async function gwAgents() {
  const { json } = await gwFetch('/centraid/_vault/agents');
  return json?.agents ?? [];
}

/** Scaffold a throwaway automation app with a CUSTOM handler.js (verbatim
 *  recipe from flows-automations-03-corners.mjs). */
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

/** Owner approval of an automation's agent grant -- POST /_vault/agents/<appId>/grants. */
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

// Same handler shape as flows-automations-03-corners.mjs's AGENT_PURGE_HANDLER_JS.
const AGENT_PURGE_HANDLER_JS = `const PURPOSE = 'dpv:ServiceProvision';

/**
 * E2E harness handler (flows-automations-05-grants-rename.mjs). Reads the
 * vault as THIS automation's enrolled agent to find a trashed Locker item,
 * then invokes the confirm-gated locker.purge_item command -- exercising the
 * automation-as-agent consent-parking path so this suite can rename/revoke
 * around a REAL parked invocation.
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

async function installLockerAndSeedTrashedItem() {
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
  let trashedCount = 0;
  const trashDeadline = Date.now() + 8_000;
  while (Date.now() < trashDeadline) {
    trashedCount = await fl2.locator('.v-item', { hasText: LOCKER_TARGET_TITLE }).count();
    if (trashedCount === 1) break;
    await page.waitForTimeout(400);
  }
  assert(trashedCount === 1, `expected "${LOCKER_TARGET_TITLE}" trashed once, got ${trashedCount}`);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const t0 = Date.now();
  session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  page.setDefaultTimeout(60_000);
  console.log(`[auto05] launched (fresh vault) + Home ready in ${Date.now() - t0}ms`);

  let parkedInvocationId = null;
  let grantIdForRevoke = null;

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    // -----------------------------------------------------------------
    // FLOW 1: rename-propagates-everywhere
    // -----------------------------------------------------------------
    await step(
      'rename-propagates-everywhere',
      'Adopt Trip albums, note its name on Home/Overview/View/Insights, rename via the real editor UI, verify propagation with NO stale surface',
      async () => {
        // ---- adopt ----
        await navTo(page, 'Discover');
        await page.getByRole('tab', { name: /^Automations/ }).click();
        await page.waitForTimeout(200);
        const card = page
          .locator('button[data-kind="automation"]', { hasText: TEMPLATE_HEALTH })
          .first();
        await card.waitFor({ state: 'visible', timeout: 10_000 });
        await card.click();
        const adoptDialog = page.getByRole('dialog', { name: new RegExp(esc(TEMPLATE_HEALTH)) });
        await adoptDialog.waitFor({ state: 'visible', timeout: 10_000 });
        await adoptDialog.getByRole('button', { name: 'Use template' }).click();
        // Adopting a template now lands directly on the automation's
        // THREAD screen (AutomationThreadScreen.tsx) -- the old builder-chat
        // "Config" tab detour is gone; see receipts/issue-387-automations-ui-revamp.md.
        await page
          .getByRole('heading', { name: TEMPLATE_HEALTH, level: 1 })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForTimeout(500);

        // ---- BEFORE: original name visible on Home, Overview, View hero ----
        await navTo(page, 'Home');
        await page
          .getByRole('heading', { name: 'What should we build?' })
          .waitFor({ state: 'visible', timeout: 15_000 });
        const homeBefore = await page
          .locator('button[data-kind="automation"]', { hasText: TEMPLATE_HEALTH })
          .count();
        assert(
          homeBefore >= 1,
          `expected "${TEMPLATE_HEALTH}" on Home before rename, found ${homeBefore}`,
        );
        await shot('01-home-before-rename');

        await openAutomationsOverview();
        const ovBefore = await page
          .getByRole('button', { name: new RegExp(esc(TEMPLATE_HEALTH)) })
          .count();
        assert(
          ovBefore >= 1,
          `expected "${TEMPLATE_HEALTH}" on the Overview before rename, found ${ovBefore}`,
        );
        await shot('02-overview-before-rename');

        await openAutomationView(TEMPLATE_HEALTH);
        await shot('03-view-hero-before-rename');

        // ---- run it once so it has an Insights footprint ----
        await runNowFromViewScreen();
        const ref = await gwFindRef(TEMPLATE_HEALTH);
        assert(Boolean(ref), `expected a gateway row for "${TEMPLATE_HEALTH}"`);
        const { appId, automationId } = splitRef(ref);
        console.log(
          `[auto05] "${TEMPLATE_HEALTH}" ref=${ref} appId=${appId} automationId=${automationId}`,
        );

        const deadline1 = Date.now() + 30_000;
        let settled = false;
        while (Date.now() < deadline1) {
          const { json } = await gwFetch(
            `/centraid/_automations/runs?ref=${encodeURIComponent(ref)}&limit=5`,
          );
          const runs = json?.runs ?? [];
          if (runs.some((r) => typeof r.endedAt === 'number')) {
            settled = true;
            break;
          }
          await page.waitForTimeout(700);
        }
        assert(settled, 'expected the pre-rename run to settle within 30s');

        await navTo(page, 'Insights');
        await page
          .getByRole('heading', { name: 'Insights', level: 1 })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForTimeout(800);
        const insightsBefore = await bodyText();
        const hadOldNameInInsights = insightsBefore.includes(TEMPLATE_HEALTH);
        console.log(
          `[auto05] Insights shows "${TEMPLATE_HEALTH}" by name BEFORE rename: ${hadOldNameInInsights}`,
        );
        await shot('04-insights-before-rename');

        // ---- RENAME (via the real editor UI) ----
        await renameAutomationViaEditor(TEMPLATE_HEALTH, RENAMED_HEALTH);
        note(
          `Renamed via the REAL editor UI this session: Thread "Edit" -> AutomationEditorScreen.tsx's "Name" field -> "Save changes", which ` +
            `now hits a dedicated POST /centraid/_automations/update endpoint (AutomationEditorRoute.tsx onSave -> updateAutomation, ` +
            `packages/gateway/src/routes/lifecycle-automation-routes.ts handleAutomationUpdate) rather than the old out-of-band draft-file+` +
            `publish primitive this suite used before the editor landed. The old builder-chat rename path still exists too, but the editor ` +
            `is the primary mechanism now.`,
        );

        // ---- AFTER: verify propagation on all 4 surfaces ----
        await navTo(page, 'Home');
        await page
          .getByRole('heading', { name: 'What should we build?' })
          .waitFor({ state: 'visible', timeout: 15_000 });
        const homeOldAfter = await page
          .locator('button[data-kind="automation"]', { hasText: TEMPLATE_HEALTH })
          .count();
        const homeNewAfter = await page
          .locator('button[data-kind="automation"]', { hasText: RENAMED_HEALTH })
          .count();
        console.log(
          `[auto05] Home AFTER rename: old-name count=${homeOldAfter}, new-name count=${homeNewAfter}`,
        );
        await shot('05-home-after-rename');
        assert(
          homeNewAfter >= 1,
          `expected "${RENAMED_HEALTH}" on Home after rename, found ${homeNewAfter}`,
        );
        assert(
          homeOldAfter === 0,
          `expected 0 stale "${TEMPLATE_HEALTH}" cards on Home after rename, found ${homeOldAfter}`,
        );

        await openAutomationsOverview();
        const ovOldAfter = await page
          .getByRole('button', { name: new RegExp(esc(TEMPLATE_HEALTH)) })
          .count();
        const ovNewAfter = await page
          .getByRole('button', { name: new RegExp(esc(RENAMED_HEALTH)) })
          .count();
        console.log(
          `[auto05] Overview AFTER rename: old-name count=${ovOldAfter}, new-name count=${ovNewAfter}`,
        );
        await shot('06-overview-after-rename');
        assert(
          ovNewAfter >= 1,
          `expected "${RENAMED_HEALTH}" on the Overview after rename, found ${ovNewAfter}`,
        );
        assert(
          ovOldAfter === 0,
          `expected 0 stale "${TEMPLATE_HEALTH}" rows on the Overview after rename, found ${ovOldAfter}`,
        );

        await openAutomationView(RENAMED_HEALTH);
        await shot('07-view-hero-after-rename');
        const viewBodyAfter = await bodyText();
        assert(
          !viewBodyAfter.includes(TEMPLATE_HEALTH),
          `expected the View screen to have no trace of the stale name "${TEMPLATE_HEALTH}"`,
        );

        await navTo(page, 'Insights');
        await page
          .getByRole('heading', { name: 'Insights', level: 1 })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForTimeout(800);
        const insightsAfter = await bodyText();
        const hasNewNameInInsights = insightsAfter.includes(RENAMED_HEALTH);
        const hasOldNameInInsights = insightsAfter.includes(TEMPLATE_HEALTH);
        console.log(
          `[auto05] Insights AFTER rename: new name shown=${hasNewNameInInsights}, stale old name shown=${hasOldNameInInsights}`,
        );
        await shot('08-insights-after-rename');
        assert(
          hasNewNameInInsights,
          `expected Insights "By source" to show "${RENAMED_HEALTH}" for the PRE-rename run, got body head: ${insightsAfter.slice(0, 500)}`,
        );
        assert(
          !hasOldNameInInsights,
          `expected Insights to show NO trace of the stale name "${TEMPLATE_HEALTH}" after rename`,
        );

        note(
          `rename-propagates-everywhere: renaming "${TEMPLATE_HEALTH}" -> "${RENAMED_HEALTH}" (via the real editor UI's Name field + "Save changes", no extra reload/refresh ` +
            `beyond ordinary navigation) propagated CLEANLY to all 4 surfaces (Home AutoCard, Automations overview row, View screen hero, and ` +
            `the Insights "By source" panel — including for the run recorded BEFORE the rename). No stale cache anywhere: each surface re-fetches ` +
            `the live manifest name (trip-albums's automation.json) on navigation, and Insights resolves automation_ref -> name live too ` +
            `(InsightsRoute.tsx:22-34) rather than snapshotting a name at run time.`,
        );
      },
    );

    // -----------------------------------------------------------------
    // FLOW 2: rename-mid-parked-invocation
    // -----------------------------------------------------------------
    await step(
      'rename-mid-parked-invocation',
      'Scaffold a custom automation with a locker.purge_item handler, grant its agent, park an invocation, THEN rename the automation BEFORE approving -- observe what the parked row shows',
      async () => {
        await installLockerAndSeedTrashedItem();
        await shot('09-locker-item-trashed');

        await scaffoldCustomAutomation({
          id: AGENT_ID,
          name: AGENT_NAME,
          handlerJs: AGENT_PURGE_HANDLER_JS,
        });
        grantIdForRevoke = await approveAgentGrant(AGENT_ID, [
          { schema: 'locker', verbs: 'read+act' },
        ]);
        console.log(`[auto05] approved agent grant ${grantIdForRevoke} for "${AGENT_ID}"`);

        const agentsAfterGrant = await gwAgents();
        const agentRow = agentsAfterGrant.find((a) => a.name === AGENT_NAME);
        assert(
          Boolean(agentRow),
          `expected an enrolled agent named "${AGENT_NAME}" right after grant approval`,
        );
        console.log(
          `[auto05] agent enrolled with real manifest name pre-park: ${JSON.stringify(agentRow.name)}`,
        );

        await openAutomationView(AGENT_NAME);
        await runNowFromViewScreen();
        await page.waitForTimeout(1000);
        await shot('10-agent-purge-run-view-after-click');

        const parkDeadline = Date.now() + 30_000;
        let parked = null;
        while (Date.now() < parkDeadline) {
          const blocking = await gwBlocking();
          parked = (blocking.parked ?? []).find((p) => p.command === 'locker.purge_item');
          if (parked) break;
          await page.waitForTimeout(700);
        }
        assert(
          Boolean(parked),
          'expected a parked locker.purge_item invocation within 30s of Run now',
        );
        parkedInvocationId = parked.invocationId;
        console.log(
          `[auto05] parked BEFORE rename: invocationId=${parkedInvocationId} caller=${JSON.stringify(parked.caller)} grantId=${JSON.stringify(parked.grantId ?? '(not exposed on this DTO)')}`,
        );
        assert(
          parked.caller === AGENT_NAME,
          `expected the parked row's caller to be the pre-rename name "${AGENT_NAME}", got ${JSON.stringify(parked.caller)}`,
        );

        await goApprovals(page);
        await shot('11-approvals-parked-before-rename');
        const rowBefore = parkedRowToggle(page, 'locker.purge_item', 0);
        await rowBefore.waitFor({ state: 'visible', timeout: 10_000 });
        const rowTextBefore = await rowBefore.textContent();
        console.log(
          `[auto05] Approvals row text BEFORE rename: ${JSON.stringify(rowTextBefore.replace(/\n/g, ' | '))}`,
        );
        assert(
          rowTextBefore.includes(AGENT_NAME),
          `expected the Approvals row to show "${AGENT_NAME}" before rename, got: ${rowTextBefore}`,
        );

        // ---- RENAME the automation while its invocation sits parked ----
        // (out-of-band, via the update endpoint -- see
        // renameAutomationViaUpdateEndpoint's doc comment for why this flow
        // can't drive the rename through the editor UI like flow 1 does.)
        await renameAutomationViaUpdateEndpoint(`${AGENT_ID}/${AGENT_ID}`, RENAMED_AGENT_NAME);

        const agentsAfterRename = await gwAgents();
        const agentRowAfterRename = agentsAfterRename.find((a) => a.partyId === agentRow.partyId);
        console.log(
          `[auto05] agent display_name AFTER rename+republish: ${JSON.stringify(agentRowAfterRename?.name)}`,
        );
        assert(
          agentRowAfterRename?.name === RENAMED_AGENT_NAME,
          `expected the agent's display name to update to "${RENAMED_AGENT_NAME}" on the next reconcile, got ${JSON.stringify(agentRowAfterRename?.name)}`,
        );

        // ---- what does the STILL-PARKED invocation show now? ----
        const blockingAfterRename = await gwBlocking();
        const parkedAfterRename = (blockingAfterRename.parked ?? []).find(
          (p) => p.invocationId === parkedInvocationId,
        );
        assert(
          Boolean(parkedAfterRename),
          'expected the SAME parked invocation to still be present after the rename (rename must not drop it)',
        );
        console.log(
          `[auto05] parked AFTER rename (same invocationId=${parkedInvocationId}): caller=${JSON.stringify(parkedAfterRename.caller)}`,
        );

        // Approvals was ALREADY the active route from the "before rename"
        // check above (no navigation away in between) -- ApprovalsRoute.tsx's
        // own header comment says "there's no gateway push channel for the
        // vault plane yet, so every decision reloads explicitly": with no
        // remount and no decision made, the mounted screen should keep
        // showing whatever it last fetched. Check this LEFT-OPEN case first,
        // informationally, before forcing a genuine fresh look.
        await page.waitForTimeout(400);
        await shot('12-approvals-parked-after-rename-left-open');
        const rowLeftOpen = parkedRowToggle(page, 'locker.purge_item', 0);
        await rowLeftOpen.waitFor({ state: 'visible', timeout: 10_000 });
        const rowTextLeftOpen = await rowLeftOpen.textContent();
        console.log(
          `[auto05] Approvals row text, LEFT OPEN across the rename (no renav, no decision): ${JSON.stringify(rowTextLeftOpen.replace(/\n/g, ' | '))}`,
        );
        note(
          `rename-mid-parked-invocation, LEFT-OPEN case: with the Approvals screen already open and left mounted across the rename (no ` +
            `navigation away, no decision made), its row kept showing the PRE-rename caller ("${rowTextLeftOpen.includes(AGENT_NAME) && !rowTextLeftOpen.includes(RENAMED_AGENT_NAME) ? AGENT_NAME : rowTextLeftOpen}") even though GET /_vault/blocking already reflects the new name. This is ` +
            `consistent with ApprovalsRoute.tsx's own header comment ("there's no gateway push channel for the vault plane yet, so every ` +
            `decision reloads explicitly") -- not a bug, just a real staleness window inherent to a poll-on-mount-or-decision screen with no ` +
            `live push channel. Not filed as a bug; the meaningful case is a FRESH look, checked next.`,
        );

        // Now force a genuine fresh look: navigate away to a different route
        // and back, which remounts ApprovalsRoute and re-fetches GET
        // /_vault/blocking from scratch -- this is the fair test of "does a
        // rename propagate to the Approvals surface", matching how flow 1
        // verified the other 4 surfaces.
        await navTo(page, 'Home');
        await page
          .getByRole('heading', { name: 'What should we build?' })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await goApprovals(page);
        await page.waitForTimeout(400);
        await shot('13-approvals-parked-after-rename-fresh-look');
        const rowAfter = parkedRowToggle(page, 'locker.purge_item', 0);
        await rowAfter.waitFor({ state: 'visible', timeout: 10_000 });
        const rowTextAfter = await rowAfter.textContent();
        console.log(
          `[auto05] Approvals row text AFTER rename, FRESH LOOK (navigated away + back): ${JSON.stringify(rowTextAfter.replace(/\n/g, ' | '))}`,
        );

        const uiShowsNewName = rowTextAfter.includes(RENAMED_AGENT_NAME);
        const uiShowsOldName =
          rowTextAfter.includes(AGENT_NAME) && !rowTextAfter.includes(RENAMED_AGENT_NAME);
        const apiShowsNewName = parkedAfterRename.caller === RENAMED_AGENT_NAME;

        // On a FRESH look, API and UI must AGREE -- a mismatch between what
        // GET /_vault/blocking returns and what a freshly-mounted Approvals
        // row paints for the SAME invocationId would be a real bug (two
        // different names for one invocation at the same instant).
        assert(
          uiShowsNewName === apiShowsNewName,
          `API/UI disagree on whether a FRESH LOOK at the parked row shows the NEW name -- API caller="${parkedAfterRename.caller}" (matches new=${apiShowsNewName}), UI row text=${JSON.stringify(rowTextAfter)}`,
        );

        note(
          `rename-mid-parked-invocation, FRESH-LOOK case: the SAME still-parked invocation (id=${parkedInvocationId}, parked BEFORE the rename ` +
            `under caller="${AGENT_NAME}"), viewed via a genuine remount (navigate away + back), now shows caller="${parkedAfterRename.caller}" ` +
            `from GET /_vault/blocking, and the freshly-mounted Approvals UI row agrees (shows new name=${uiShowsNewName}, shows old name=` +
            `${uiShowsOldName}). This matches source: gateway.ts's listParked()/callerName() re-join agent_agent -> core_party.display_name ` +
            `LIVE on every call rather than reading a value captured at park time, so a freshly-loaded parked row is a live view of "who this ` +
            `identity currently is", not a historical snapshot of "who parked this". This is a legitimate design choice (not a bug): the ` +
            `caller identity itself hasn't changed -- only its display label has -- and a fresh look never shows a stale raw-slug fallback, ` +
            `two different names for the same invocation, or a crash. The only staleness is the already-documented LEFT-OPEN window above, ` +
            `which self-heals on any renav or decision.`,
        );
      },
    );

    // -----------------------------------------------------------------
    // FLOW 3: revoke-mid-flight
    // -----------------------------------------------------------------
    await step(
      'revoke-mid-flight',
      "Revoke the automation agent's grant while its invocation is STILL parked (no UI surface exists for this -- use the owner API DELETE route) -- document the exact resulting behavior",
      async () => {
        assert(Boolean(parkedInvocationId), 'need a parked invocation carried over from flow 2');
        assert(Boolean(grantIdForRevoke), "need the grantId from flow 2's approveAgentGrant");

        const blockingBefore = await gwBlocking();
        const stillParkedBefore = (blockingBefore.parked ?? []).some(
          (p) => p.invocationId === parkedInvocationId,
        );
        assert(
          stillParkedBefore,
          'expected the invocation to still be parked immediately before revoke',
        );

        const revokeRes = await gwFetch(
          `/centraid/_vault/grants/${encodeURIComponent(grantIdForRevoke)}`,
          { method: 'DELETE' },
        );
        console.log(
          `[auto05] DELETE /_vault/grants/${grantIdForRevoke} -> status=${revokeRes.status} body=${JSON.stringify(revokeRes.json)}`,
        );
        assert(
          revokeRes.status === 200,
          `expected the revoke to succeed, got ${JSON.stringify(revokeRes)}`,
        );
        note(
          `revoke-mid-flight mechanism: there is NO UI surface anywhere in the renderer for revoking an automation agent's vault schema grant -- ` +
            `Approvals' own "Standing grants" section (ApprovalsScreen.tsx GrantRow) is wired to listOutboxGrants()/revokeOutboxGrant, a totally ` +
            `separate "always allow outbox rule" family. The only real mechanism today is the owner API directly: DELETE /centraid/_vault/grants/` +
            `<grantId> (packages/gateway/src/routes/vault-routes.ts:320-330). Used that directly, per the task brief.`,
        );

        const blockingAfterRevoke = await gwBlocking();
        const stillParkedAfterRevoke = (blockingAfterRevoke.parked ?? []).find(
          (p) => p.invocationId === parkedInvocationId,
        );
        console.log(
          `[auto05] parked invocation present in GET /_vault/blocking AFTER revoke: ${Boolean(stillParkedAfterRevoke)}`,
        );

        // Approvals was already the active, mounted route from the end of
        // flow 2 (no gateway push channel — ApprovalsRoute.tsx's own header
        // comment — so a left-open screen won't auto-refresh on a background
        // revoke). Force a genuine fresh mount (navigate away, then back) so
        // this check reflects what the owner actually sees on a real look,
        // not a stale left-open snapshot from before the revoke.
        await navTo(page, 'Home');
        await page
          .getByRole('heading', { name: 'What should we build?' })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await goApprovals(page);
        await page.waitForTimeout(400);
        await shot('13-approvals-after-revoke-fresh-look');
        const rowsAfterRevoke = await page
          .locator('button', { hasText: 'locker.purge_item' })
          .count();
        console.log(
          `[auto05] Approvals rows for "locker.purge_item" visible after revoke (FRESH LOOK): ${rowsAfterRevoke}`,
        );
        assert(
          rowsAfterRevoke === 0,
          `expected the revoked-and-dropped parked row to be GONE from a freshly-mounted Approvals screen, found ${rowsAfterRevoke}`,
        );

        // Attempt to approve the (possibly-gone) invocation directly over the
        // API -- proves whether it's cleanly gone (404) vs. an
        // unapprovable-forever ghost vs. one that still silently executes
        // without a live grant.
        const approveAttempt = await gwFetch(
          `/centraid/_vault/parked/${encodeURIComponent(parkedInvocationId)}`,
          {
            method: 'POST',
            body: { approve: true },
          },
        );
        console.log(
          `[auto05] POST /_vault/parked/${parkedInvocationId} {approve:true} AFTER revoke -> status=${approveAttempt.status} body=${JSON.stringify(approveAttempt.json)}`,
        );

        const cleanlyDropped =
          !stillParkedAfterRevoke && rowsAfterRevoke === 0 && approveAttempt.status === 404;
        const executedWithoutGrant =
          approveAttempt.status === 200 && approveAttempt.json?.status === 'executed';
        const stuckForever =
          Boolean(stillParkedAfterRevoke) &&
          approveAttempt.status !== 404 &&
          approveAttempt.status !== 200;

        console.log(
          `[auto05] classification: cleanlyDropped=${cleanlyDropped}, executedWithoutGrant=${executedWithoutGrant}, stuckForever=${stuckForever}`,
        );

        assert(
          !executedWithoutGrant,
          `BUG: the parked invocation executed (status="executed") AFTER its grant was revoked -- a revoke let execution proceed without a live grant. approveAttempt=${JSON.stringify(approveAttempt)}`,
        );
        assert(
          !(Boolean(stillParkedAfterRevoke) && approveAttempt.status !== 404),
          `BUG: revoke left the parked invocation in a stuck/unapprovable-forever-but-still-listed state -- stillParked=${JSON.stringify(stillParkedAfterRevoke)}, approveAttempt=${JSON.stringify(approveAttempt)}`,
        );

        // Also confirm Locker's trash still holds the target -- the item
        // must NOT have been purged by a revoke that let execution slip
        // through.
        const fl = await openLocker(page);
        await fl.locator('button.v-nav-item', { hasText: 'Trash' }).click();
        await page.waitForTimeout(400);
        const stillInTrash = await fl.locator('.v-item', { hasText: LOCKER_TARGET_TITLE }).count();
        console.log(
          `[auto05] "${LOCKER_TARGET_TITLE}" still in Locker trash after revoke (must be 1, NOT purged): ${stillInTrash}`,
        );
        await shot('14-locker-trash-after-revoke-not-purged');
        assert(
          stillInTrash === 1,
          `expected "${LOCKER_TARGET_TITLE}" to remain un-purged after a mid-flight revoke, found count=${stillInTrash}`,
        );

        note(
          `revoke-mid-flight OBSERVED BEHAVIOR: revoking the grant (DELETE /_vault/grants/${grantIdForRevoke}) that a park depended on ` +
            `CLEANLY DROPPED the parked invocation -- gone from GET /_vault/blocking (present-after=${Boolean(stillParkedAfterRevoke)}), gone ` +
            `from the Approvals UI (rows-after=${rowsAfterRevoke}), and a direct API approve attempt on its now-gone id 404s ` +
            `(status=${approveAttempt.status}, body=${JSON.stringify(approveAttempt.json)}) instead of silently executing or hanging. The ` +
            `underlying Locker item was confirmed NOT purged (still count=1 in trash). This matches source (gateway.ts revokeGrant -> ` +
            `revokeGrantCascade's callback: drops the parked map entry AND marks the invocation 'failed') and is judged a CORRECT, clean design ` +
            `-- a revoke reads as "no to everything this grant authorized, right now", not merely "no to future asks". Not filed as a bug.`,
        );
      },
    );

    // -----------------------------------------------------------------
    // FLOW 4: re-grant-recovery
    // -----------------------------------------------------------------
    await step(
      're-grant-recovery',
      "Re-grant the same automation's agent access after the revoke -- a fresh Run now must work end to end again with no leftover broken state",
      async () => {
        const newGrantId = await approveAgentGrant(AGENT_ID, [
          { schema: 'locker', verbs: 'read+act' },
        ]);
        console.log(`[auto05] re-granted: new grantId=${newGrantId} (old was ${grantIdForRevoke})`);
        assert(
          newGrantId !== grantIdForRevoke,
          'expected a FRESH grantId from the re-grant, not the old (revoked) one reused',
        );

        const agentsAfterRegrant = await gwAgents();
        const agentRow = agentsAfterRegrant.find((a) => a.name === RENAMED_AGENT_NAME);
        assert(
          Boolean(agentRow),
          `expected the agent to still carry its renamed display name "${RENAMED_AGENT_NAME}" after re-grant`,
        );
        assert(
          agentRow.grants.some((g) => g.grantId === newGrantId),
          'expected the fresh grant to be listed as active on the agent',
        );

        await openAutomationView(RENAMED_AGENT_NAME);
        await shot('15-view-before-regrant-run');
        await runNowFromViewScreen();
        await page.waitForTimeout(1000);
        await shot('16-view-after-regrant-run');

        const deadline = Date.now() + 30_000;
        let parkedAgain = null;
        while (Date.now() < deadline) {
          const blocking = await gwBlocking();
          parkedAgain = (blocking.parked ?? []).find((p) => p.command === 'locker.purge_item');
          if (parkedAgain) break;
          await page.waitForTimeout(700);
        }
        assert(
          Boolean(parkedAgain),
          'expected a FRESH parked locker.purge_item invocation within 30s of re-grant + Run now (end-to-end recovery)',
        );
        assert(
          parkedAgain.invocationId !== parkedInvocationId,
          'expected a NEW invocationId, not the old revoked one resurrected',
        );
        console.log(
          `[auto05] fresh park after re-grant: invocationId=${parkedAgain.invocationId} caller=${JSON.stringify(parkedAgain.caller)}`,
        );
        assert(
          parkedAgain.caller === RENAMED_AGENT_NAME,
          `expected the fresh park's caller to be the current name "${RENAMED_AGENT_NAME}", got ${JSON.stringify(parkedAgain.caller)}`,
        );

        // Approve it for real -- proves recovery end to end, not just "it parked".
        await goApprovals(page);
        await page.waitForTimeout(400);
        await shot('17-approvals-fresh-park-after-regrant');
        const row = parkedRowToggle(page, 'locker.purge_item', 0);
        await row.waitFor({ state: 'visible', timeout: 10_000 });
        const approveBtn = page.getByRole('button', { name: 'Approve', exact: true });
        if (!(await approveBtn.isVisible().catch(() => false))) {
          await row.click();
          await page.waitForTimeout(200);
        }
        await approveBtn.click();
        await page.waitForTimeout(800);
        await shot('18-approvals-after-approve-post-regrant');

        const fl = await openLocker(page);
        await fl.locator('button.v-nav-item', { hasText: 'Trash' }).click();
        await page.waitForTimeout(400);
        const purgedNow = await fl.locator('.v-item', { hasText: LOCKER_TARGET_TITLE }).count();
        console.log(
          `[auto05] "${LOCKER_TARGET_TITLE}" in Locker trash after re-grant + fresh approve (expect 0, purged for real): ${purgedNow}`,
        );
        await shot('19-locker-trash-purged-after-recovery');
        assert(
          purgedNow === 0,
          `expected "${LOCKER_TARGET_TITLE}" to be purged for real after the post-recovery approval, found ${purgedNow}`,
        );

        note(
          `re-grant-recovery: after the revoke in flow 3, re-granting the SAME automation's agent access (fresh grantId=${newGrantId}) fully ` +
            `recovered the flow end to end -- a new "Run now" produced a NEW parked invocation (not a resurrection of the old revoked one), ` +
            `carrying the agent's current renamed display name, and approving it executed for real (the Locker item was purged). No leftover ` +
            `broken state from the revoke.`,
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
        // flow3 deliberately POSTs to /_vault/parked/<invocationId> for an
        // invocationId it just proved is gone (revoked-and-dropped), to assert
        // the endpoint answers 404 cleanly rather than executing or hanging.
        // The browser's own devtools console logs that same real, expected
        // 404 as a "Failed to load resource" entry -- this is the deliberate
        // assertion's OWN network call surfacing in the console, not a
        // product bug, so it's excluded here by its distinctive URL. Every
        // other console error still fails the sweep.
        const allErrors = consoleMessages.filter((m) => m.type === 'error');
        // A "Failed to load resource" console entry carries the failed
        // resource's own URL in `frameUrl` (msg.location().url), NOT in
        // `.text()` (the text is just the generic "...responded with a status
        // of 404..." string) -- match on frameUrl, per the harness's own
        // console-filter convention (never match on text alone).
        const expected404Url = /_vault\/parked\//;
        // "Potential permissions policy violation: clipboard-read/write is
        // not allowed in this document" -- a second, pre-existing/
        // out-of-scope noise source, unrelated to any automations UI
        // change (reproduces with Locker in flows-automations-03-corners.mjs
        // AND with no Locker at all in flows-automations-04-trigger-fires.mjs;
        // see either suite's isKnownBenignConsoleError() for the fuller
        // citation). This flow also opens Locker (installLockerAndSeedTrashedItem),
        // so exclude it here too.
        const isBenignClipboard = (m) =>
          /Potential permissions policy violation: clipboard-(read|write) is not allowed/.test(
            m.text,
          );
        const unexpected = allErrors.filter(
          (m) => !(expected404Url.test(m.frameUrl) && /404/.test(m.text)) && !isBenignClipboard(m),
        );
        for (const e of allErrors) console.log(`  CONSOLE ERROR: ${e.text} (${e.frameUrl})`);
        console.log(
          `[auto05] console errors: ${allErrors.length} total, ${allErrors.length - unexpected.length} excluded as the deliberate revoke-then-approve-attempt 404 from flow 3 and/or known-benign clipboard permissions-policy noise`,
        );
        assert(
          unexpected.length === 0,
          `expected 0 UNEXPECTED console errors across the suite, got ${unexpected.length}: ${JSON.stringify(unexpected.map((e) => e.text))}`,
        );
      },
    );

    // -----------------------------------------------------------------
    // Report
    // -----------------------------------------------------------------
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ AUTOMATIONS GRANTS+RENAME VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(34)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${String(r.error).split('\n')[0]}`);
    }
    console.log('===========================================================================');
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
      console.log('\nAll automations-grants-rename steps PASSED.');
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
