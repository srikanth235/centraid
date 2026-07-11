#!/usr/bin/env node
// governance: allow-repo-hygiene file-size-limit (#363) single coherent multi-step live-app QA scenario against the real Electron+gateway rig; splitting mid-scenario would fragment one flow across files with no readability gain
// Automations TRIGGER-FIRES suite: closes the two gaps left open by
// flows-automations-02-triggers.mjs — a condition trigger that ACTUALLY
// fires against a real matching vault row (not just documented via a
// manifest snippet), and a data trigger that ACTUALLY exercises the
// bootstrap-cursor-then-real-fire path (a genuine post-bootstrap write,
// not a best-effort "0 runs observed, might just mean 0 evaluate() calls
// happened" conclusion). Also covers two same-tick cron automations firing
// together without dropping either run.
//
// SOURCE-VERIFIED FACTS this suite relies on (read before touching timings
// or assertions — re-derive from source if any of these stop matching):
//   - packages/automation/src/fire/condition.ts:109-162 evaluateConditionTrigger
//     — a FRESH `where`-query every evaluate() call, content-hash dedup (the
//     "cursor" is the set of hashes CURRENTLY matching). No bootstrap
//     suppression: the first-ever evaluate() DOES fire if matching rows
//     already exist at that moment. `fire: fresh.length > 0` (line 158).
//   - condition.ts:192-229 evaluateDataTrigger — cursor is the journal's
//     strictly-time-ordered prov id; `fire: cursor !== null && changes.length
//     > 0` (line 228) — the FIRST-EVER evaluate() (cursor===null) ALWAYS
//     sets the watermark WITHOUT firing, regardless of matches. Only a
//     SUBSEQUENT evaluate() that finds NEW changes since that watermark fires.
//   - packages/gateway/src/serve/build-gateway.ts:816-878 evaluateCondition —
//     the host glue; stamps `triggerOrigin:'condition'` (line 846) /
//     `triggerOrigin:'data'` (line 871). Fire is decided BEFORE the handler
//     worker starts (packages/automation/src/handler/runner.ts:534-543
//     insertTurn precedes `new Worker(...)` at line 566) — so a run record
//     with the right triggerOrigin lands even if the handler itself later
//     throws (e.g. a doc-text-extractor `ctx.agent` call with no model
//     configured). Proving the FIRE never requires the handler to succeed.
//   - packages/automation/src/manifest/manifest.ts:146,170 — CONDITION_
//     DEFAULT_EVERY='*/5 * * * *', DATA_DEFAULT_EVERY='* * * * *'; no
//     hardcoded minimum overrides a custom `every` — '* * * * *' is legal on
//     BOTH kinds and the InProcessScheduler (in-process-scheduler.ts:135-163)
//     calls evaluate() every wall-clock minute for it.
//   - packages/gateway/src/routes/lifecycle-automation-routes.ts:54-62 — POST
//     /centraid/_automations still rejects any non-cron/non-webhook trigger
//     kind with 400 (verified in flows-automations-02-triggers.mjs's
//     api-trigger-coercion flow) — condition/data triggers can ONLY be
//     minted via the file-based template-clone route + a draft-file
//     overwrite of `every`/`enabled`, same recipe as this suite uses.
//   - packages/gateway/src/routes/lifecycle-routes.ts:182-262 handleClone —
//     POST /centraid/_apps/_clone {templateId, publish:false} returns
//     {app:{id,name}, sessionId, staged:true} with the SAME automation
//     subfolder id as the template (only the owning appId/name are
//     renamed) — so the draft file to overwrite stays
//     `automations/<templateAutomationId>/automation.json` under the new
//     appId.
//   - packages/gateway/src/serve/vault-plane.ts:550-620 ensureInstallGrant —
//     "installing was the consent for the declared block": a freshly
//     enrolled automation agent gets ALL of its manifest's declared
//     vault.scopes auto-granted the moment reconcileScheduler next runs
//     (on publish) — no separate `/_vault/agents/<id>/grants` call needed
//     for a template clone (unlike flows-automations-03-corners.mjs's
//     from-scratch custom-handler scaffold, which bypasses the normal
//     install path and DOES need an explicit grant).
//   - packages/vault/src/commands/schedule.ts:12-70 schedule.propose_event —
//     has a `calendar_exists` precondition (SELECT count(*) FROM
//     schedule_calendar WHERE calendar_id=:calendar_id) and NO production
//     code path anywhere in the repo ever creates a schedule_calendar row
//     (grepped packages/vault/src/commands/*.ts and the Agenda blueprint —
//     every `INSERT INTO schedule_calendar` in the whole tree lives only in
//     *.test.ts files). packages/blueprints/apps/agenda/app.js:348 literally
//     hides the "new event" form when `calendars.length === 0`. A FRESH
//     desktop vault has zero calendars, so there is NO real-app UI path
//     (Agenda or otherwise) to create a `core.event` row today — this is a
//     genuine product gap, reported as a finding below, not a workaround.
//   - packages/gateway/src/routes/vault-routes.ts (whole file, per its own
//     header comment) exposes only consent/grant/outbox/link/picker
//     surface — no raw SQL/insert HTTP route exists for an owner to seed
//     arbitrary vault rows out-of-band.
//   - packages/vault/src/bootstrap.ts:102-116 — the vault's owner party id
//     lives at `core_vault.owner_party_id` (seeded once at vault creation).
//   - Given the above, this suite seeds the ONE real.core.event row
//     renewal-reminders needs via a raw sqlite3 CLI INSERT directly into
//     the profile's `vault.db` — but ONLY while the app is fully closed
//     (session.close()), to avoid any concurrent-writer risk against the
//     gateway's own better-sqlite3 WAL connection. This is the same
//     "close, mutate on disk, reopen with the same userDataDir" pattern
//     flows-full.mjs already uses (S2-upload's persistence check) — just
//     applied to a write instead of a restart-persistence read.
//   - packages/blueprints/apps/docs/actions/upload.js calls
//     `core.add_document`, which (packages/vault/src/commands/documents.ts:
//     200) does `ctx.wrote('core.content_item', contentId)` — the real,
//     in-app, no-SQL-surgery way to produce a genuinely NEW core.content_item
//     row for the doc-text-extractor data trigger to see. The upload wires
//     through a plain hidden `<input id="uploadInput" type="file" multiple
//     hidden>` (packages/blueprints/apps/docs/index.html:290) with a
//     `change` listener (chrome.js:81) — `setInputFiles(...)` on it (same
//     recipe as flows-full.mjs's S2-upload flow) is a real upload, not a
//     mock.
//   - apps/desktop/src/renderer/react/shell/routes/automationsData.ts:
//     208-216 kindEyebrow and :229-238 per-run trigLabel — CONFIRMS the
//     "Condition"/"Data trigger" honest labels exist in the CURRENT code
//     (this session's fix over flows-automations-02-triggers.mjs's
//     observation that condition/data-origin runs used to fall into the
//     generic "Cron" bucket).
//
// HARNESS NOTES carried over verbatim from suites 01-03 (read first):
//   - the enable switch is a visually-hidden `<input role="switch">` --
//     `waitFor({state:'attached'})` not 'visible', click the `<label>`
//     wrapper, not the 0x0 input.
//   - timeline node heads: `button[class*="tlHead"]`.
//   - `document.body.innerText` is CSS-uppercased on some labels -- match
//     case-insensitively.
//   - console-error filters must check `msg.location().url` (frameUrl),
//     never the message text.
//   - NEVER use a bare `[aria-expanded]` selector.
//
// Run with: node apps/desktop/tests/e2e-live/flows-automations-04-trigger-fires.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { launchApp, navTo } from './driver.mjs';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-automations-04-trigger-fires');
const FIXTURES_DIR = path.join(__dirname, 'out', 'fixtures-auto04');

const TEMPLATE_CONDITION_ID = 'renewal-reminders';
const CONDITION_AUTOMATION_SUBFOLDER = 'renewal-reminders'; // unchanged by clone
const TEMPLATE_DATA_ID = 'doc-text-extractor';
const DATA_AUTOMATION_SUBFOLDER = 'doc-text-extractor'; // unchanged by clone

const CRON_A_ID = 'e2e-cron-tick-a';
const CRON_A_NAME = 'e2e cron tick A';
const CRON_B_ID = 'e2e-cron-tick-b';
const CRON_B_NAME = 'e2e cron tick B';

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
  console.log(`[auto04] FINDING: ${msg}`);
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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-auto04-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `auto04-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

// ---- out-of-band gateway JSON fetch (owner-device auth, same pattern as
// flows-automations-01/02/03.mjs) ----
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
 *  with the literal text content as the body (route-helpers.ts's readBody,
 *  not readJson -- no JSON envelope). Mirrors flows-automations-03-corners.mjs. */
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

/** Clone a bundled template WITHOUT publishing, so its files stay editable
 *  in the returned session -- packages/gateway/src/routes/lifecycle-routes.ts:182-262. */
async function cloneTemplateUnpublished(templateId) {
  const res = await gwFetch('/centraid/_apps/_clone', {
    method: 'POST',
    body: { templateId, publish: false },
  });
  assert(res.status === 201, `clone of template "${templateId}" failed: ${JSON.stringify(res)}`);
  const appId = res.json?.app?.id;
  const name = res.json?.app?.name;
  const sessionId = res.json?.sessionId;
  assert(
    Boolean(appId) && Boolean(name) && Boolean(sessionId),
    `clone response missing fields: ${JSON.stringify(res.json)}`,
  );
  console.log(
    `[auto04] cloned template "${templateId}" -> appId="${appId}" name="${name}" sessionId="${sessionId}"`,
  );
  return { appId, name, sessionId };
}

async function publishSession(appId, sessionId, message) {
  const res = await gwFetch(`/centraid/_apps/${encodeURIComponent(appId)}/publish`, {
    method: 'POST',
    body: { sessionId, message },
  });
  assert(res.status === 201, `publish of "${appId}" failed: ${JSON.stringify(res)}`);
  return res.json;
}

/**
 * Clone a template, force its ONE automation trigger's `every` to a fast
 * cadence + `enabled:true`, and publish -- the only legitimate way to get a
 * condition/data trigger with a test-friendly cadence live (POST
 * /centraid/_automations rejects those kinds outright, see header comment).
 */
async function cloneAndSpeedUpTrigger(templateId, automationSubfolder, fastEvery) {
  const { appId, name, sessionId } = await cloneTemplateUnpublished(templateId);
  const rel = `automations/${automationSubfolder}/automation.json`;
  const raw = await getDraftFile(appId, sessionId, rel);
  const manifest = JSON.parse(raw);
  assert(
    Array.isArray(manifest.triggers) && manifest.triggers.length === 1,
    `expected exactly 1 trigger on "${templateId}", got ${JSON.stringify(manifest.triggers)}`,
  );
  const originalEvery = manifest.triggers[0].every;
  const originalEnabled = manifest.enabled;
  manifest.triggers[0].every = fastEvery;
  manifest.enabled = true;
  console.log(
    `[auto04] "${templateId}" trigger before: every=${originalEvery} enabled=${originalEnabled} -> after: every=${fastEvery} enabled=true`,
  );
  const putRes = await putDraftFile(appId, sessionId, rel, JSON.stringify(manifest, null, 2));
  assert(putRes.status === 200, `draft overwrite of "${rel}" failed: ${JSON.stringify(putRes)}`);
  const pub = await publishSession(
    appId,
    sessionId,
    `e2e: speed up ${templateId} trigger for real-fire test`,
  );
  console.log(`[auto04] published "${appId}": ${JSON.stringify(pub)}`);
  return { appId, name, triggerKind: manifest.triggers[0].kind };
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

// ---- sqlite3 CLI helpers (used ONLY while the app is fully closed) ----
async function findVaultDb(userDataDir) {
  const { stdout } = await execFileAsync('find', [userDataDir, '-name', 'vault.db']);
  const paths = stdout.trim().split('\n').filter(Boolean);
  assert(paths.length >= 1, `no vault.db found under ${userDataDir}: ${stdout}`);
  console.log(`[auto04] vault.db candidates: ${JSON.stringify(paths)}`);
  return paths[0];
}

async function sqliteExec(dbPath, sql) {
  const { stdout, stderr } = await execFileAsync('sqlite3', [dbPath, sql]);
  if (stderr && stderr.trim()) console.log(`[auto04] sqlite3 stderr: ${stderr.trim()}`);
  return stdout;
}

async function sqliteScalar(dbPath, sql) {
  return (await sqliteExec(dbPath, sql)).trim();
}

/**
 * Seed the ONE real core.event row renewal-reminders' condition needs:
 * status='tentative', dtstart within the next 14 days. Also seeds a
 * schedule_calendar row if none exists -- confirmed (see header comment)
 * that NO production code path in this repo can create one, so this is the
 * only way to satisfy schedule_event_ext's calendar_exists precondition
 * shape even out-of-band. MUST be called with the app fully closed.
 */
async function seedRenewalEvent(dbPath) {
  const ownerPartyId = await sqliteScalar(dbPath, 'SELECT owner_party_id FROM core_vault LIMIT 1;');
  assert(
    Boolean(ownerPartyId),
    'could not read owner_party_id from core_vault -- is the vault bootstrapped?',
  );
  console.log(`[auto04] owner_party_id: ${ownerPartyId}`);

  const calCount = Number(await sqliteScalar(dbPath, 'SELECT count(*) FROM schedule_calendar;'));
  let calendarId;
  if (calCount === 0) {
    calendarId = randomUUID();
    await sqliteExec(
      dbPath,
      `INSERT INTO schedule_calendar (calendar_id, owner_party_id, name, color, default_tz, visibility, external_uri) VALUES ('${calendarId}', '${ownerPartyId}', 'E2E Personal', NULL, 'UTC', 'private', NULL);`,
    );
    note(
      `seeded schedule_calendar row out-of-band via direct sqlite3 INSERT (app closed) -- confirmed by source reading that NO production code path (Agenda app included) can create a calendar today; packages/blueprints/apps/agenda/app.js:348 hides the "new event" form entirely when calendars.length===0, and every INSERT INTO schedule_calendar in the repo lives only in *.test.ts files. This is a real product gap: a fresh vault can never propose a calendar event through the Agenda UI.`,
    );
  } else {
    calendarId = await sqliteScalar(dbPath, 'SELECT calendar_id FROM schedule_calendar LIMIT 1;');
    console.log(`[auto04] reusing existing schedule_calendar ${calendarId}`);
  }

  const eventId = randomUUID();
  const now = new Date();
  const dtstart = new Date(now.getTime() + 2 * 86_400_000).toISOString();
  const dtend = new Date(now.getTime() + 2 * 86_400_000 + 3_600_000).toISOString();
  const nowIso = now.toISOString();
  await sqliteExec(
    dbPath,
    `INSERT INTO core_event (event_id, ical_uid, summary, description, dtstart, dtend, start_tz, rrule, status, location_place_id, organizer_party_id, sequence, created_at, updated_at) VALUES ('${eventId}', NULL, 'E2E renewal test event', NULL, '${dtstart}', '${dtend}', NULL, NULL, 'tentative', NULL, '${ownerPartyId}', 0, '${nowIso}', '${nowIso}');`,
  );
  const eventExtId = randomUUID();
  await sqliteExec(
    dbPath,
    `INSERT INTO schedule_event_ext (event_ext_id, event_id, calendar_id, busy, conferencing_uri, reminders_json, travel_buffer_min) VALUES ('${eventExtId}', '${eventId}', '${calendarId}', 'busy', NULL, NULL, NULL);`,
  );
  console.log(
    `[auto04] seeded core_event ${eventId} status=tentative dtstart=${dtstart} (within-next-days 14 of now=${nowIso})`,
  );
  return { eventId, calendarId, dtstart };
}

// ---- tiny real fixture file for the Docs upload (data-trigger real write) ----
const PNG_1PX_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
async function writeUploadFixture() {
  await fs.mkdir(FIXTURES_DIR, { recursive: true });
  const pngPath = path.join(FIXTURES_DIR, 'auto04-doc.png');
  await fs.writeFile(pngPath, Buffer.from(PNG_1PX_BASE64, 'base64'));
  return pngPath;
}

function docsFrame() {
  return page.frameLocator('iframe[data-centraid-app="1"]');
}

async function installDocsApp() {
  await navTo(page, 'Discover');
  await page.getByRole('tab', { name: /^Apps/ }).click();
  await page.waitForTimeout(200);
  const docsCard = page.locator('button[data-kind="app"]', { hasText: 'Docs' }).first();
  await docsCard.waitFor({ state: 'visible', timeout: 10_000 });
  await docsCard.click();
  const dialog = page.getByRole('dialog', { name: /^Preview Docs/ });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Use this template' }).click();
  const toast = page.locator('[data-global-toast]');
  await toast.waitFor({ state: 'visible', timeout: 10_000 });
  await page
    .getByRole('heading', { name: 'What should we build?' })
    .waitFor({ state: 'visible', timeout: 10_000 });
}

async function openDocsApp() {
  await navTo(page, 'Home');
  await page
    .getByRole('heading', { name: 'What should we build?' })
    .waitFor({ state: 'visible', timeout: 10_000 });
  const tile = page.locator('[data-app-id="docs"]');
  await tile.waitFor({ state: 'visible', timeout: 10_000 });
  await tile.getByTestId('app-tile').click();
  await page
    .locator('iframe[data-centraid-app="1"]')
    .waitFor({ state: 'attached', timeout: 15_000 });
  // The iframe DOM element attaching does NOT mean the child app's own
  // bootstrap JS has finished running yet -- chrome.js's
  // `$('uploadInput').addEventListener('change', ...)` wiring is part of
  // that bootstrap. Calling setInputFiles() before it's wired fires the
  // 'change' event with nobody listening (confirmed root cause of this
  // suite's first run: setInputFiles landed, zero cards ever appeared, zero
  // console errors -- a pure timing race, not a product bug). Wait for the
  // empty-state render (same readiness signal flows-full.mjs's S2-upload
  // flow uses) as proof the app is fully interactive first.
  await docsFrame().locator('.kit-empty').first().waitFor({ state: 'visible', timeout: 15_000 });
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const t0 = Date.now();
  session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  page.setDefaultTimeout(60_000);
  console.log(`[auto04] launched (fresh vault) + Home ready in ${Date.now() - t0}ms`);

  let conditionRef = null;
  let conditionName = null;
  let dataRef = null;
  let dataName = null;

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    // -----------------------------------------------------------------
    // FLOW: condition-trigger-real-fire
    // -----------------------------------------------------------------
    await step(
      'condition-trigger-real-fire',
      'Clone renewal-reminders with every="* * * * *", publish, seed a real matching core.event row (app closed), reopen, wait for a real triggerOrigin:"condition" run',
      async () => {
        const { appId: _appId, name } = await cloneAndSpeedUpTrigger(
          TEMPLATE_CONDITION_ID,
          CONDITION_AUTOMATION_SUBFOLDER,
          '* * * * *',
        );
        conditionName = name;

        await openAutomationView(name);
        await shot('01-condition-view-before-seed');
        const kindEyebrow = page.locator('[class*="heroKind"]');
        await kindEyebrow.waitFor({ state: 'visible', timeout: 10_000 });
        const kindText = (await kindEyebrow.textContent())?.trim() ?? '';
        console.log(
          `[auto04] condition automation hero kindEyebrow BEFORE any run: ${JSON.stringify(kindText)}`,
        );
        assert(
          /condition/i.test(kindText),
          `expected the hero eyebrow to honestly say "Condition", got ${JSON.stringify(kindText)}`,
        );

        conditionRef = await gwFindRef(name);
        assert(
          Boolean(conditionRef),
          `expected "${name}" to be a real gateway row after clone+publish`,
        );
        const preSeedRuns = await gwRuns(conditionRef);
        console.log(
          `[auto04] "${name}" run count before seeding the matching row: ${preSeedRuns.length}`,
        );

        // Close the app fully before touching vault.db on disk -- avoids any
        // concurrent-writer race against the gateway's own WAL connection
        // (see header comment). Same close+reopen shape flows-full.mjs's
        // S2-upload flow already uses for a persistence check.
        await session.close();
        await new Promise((resolve) => setTimeout(resolve, 500));

        const dbPath = await findVaultDb(USER_DATA_DIR);
        const seeded = await seedRenewalEvent(dbPath);

        session = await launchApp({ userDataDir: USER_DATA_DIR });
        page = session.page;
        wireConsole(page);
        await page.setViewportSize({ width: 1400, height: 900 });
        console.log(`[auto04] reopened app after seeding core_event ${seeded.eventId}`);

        // Poll for a real triggerOrigin:'condition' run -- scheduler aligns
        // its first tick to the NEXT minute boundary from THIS boot
        // (in-process-scheduler.ts start()), ticks every 60s thereafter, no
        // backfill -- budget for 2 boundaries same as the cron-real-fire flow
        // in flows-automations-02-triggers.mjs.
        const deadline = Date.now() + 150_000;
        let found = null;
        while (Date.now() < deadline) {
          const runs = await gwRuns(conditionRef);
          found = runs.find((r) => r.triggerOrigin === 'condition') ?? null;
          if (found) break;
          await page.waitForTimeout(10_000);
        }
        console.log(`[auto04] condition run search result: ${JSON.stringify(found)}`);
        assert(
          Boolean(found),
          `expected a real triggerOrigin:'condition' run within 150s of reopening with a matching core.event row seeded, got runs=${JSON.stringify(await gwRuns(conditionRef))}`,
        );
        console.log(
          `[auto04] CONFIRMED real condition-trigger fire: run ${found.runId} ok=${found.ok} error=${found.error ?? 'none'}`,
        );
      },
    );

    // -----------------------------------------------------------------
    // FLOW: condition-trigger-ui-confirm
    // -----------------------------------------------------------------
    await step(
      'condition-trigger-ui-confirm',
      'The fired condition run is visible in the UI with an honest "Condition" trigger label, not lumped into "Cron"',
      async () => {
        assert(
          Boolean(conditionRef) && Boolean(conditionName),
          'need a confirmed condition run from the previous flow',
        );
        await openAutomationView(conditionName);
        await shot('03-condition-view-after-fire');

        const runRows = page.locator('button[data-ok]');
        const rowCount = await runRows.count();
        console.log(`[auto04] run rows visible on the condition automation's view: ${rowCount}`);
        assert(rowCount >= 1, `expected >=1 run row, got ${rowCount}`);

        const rowText = await runRows.first().textContent();
        console.log(
          `[auto04] first run row text: ${JSON.stringify(rowText.replace(/\n/g, ' | '))}`,
        );
        assert(
          /condition/i.test(rowText),
          `expected the run row to visibly say "Condition", got: ${rowText}`,
        );

        await runRows.first().click();
        await page.waitForTimeout(1000);
        await shot('04-condition-run-view-detail');

        const finalNodes = page.locator('[data-status]');
        const nodeCount = await finalNodes.count().catch(() => 0);
        if (nodeCount > 0) {
          const finalStatus = await finalNodes.last().getAttribute('data-status');
          console.log(
            `[auto04] condition-fired run's final timeline node data-status: ${finalStatus}`,
          );
        }
        note(
          'GAP #1 CLOSED: renewal-reminders\' condition trigger was driven through a REAL fire end to end -- a genuine matching core.event row (status=tentative, dtstart within the 14-day window), a real scheduler evaluate() tick, a run record with triggerOrigin="condition", and the UI honestly labeling it "Condition" (not "Cron").',
        );
      },
    );

    // -----------------------------------------------------------------
    // FLOW: data-trigger-bootstrap-no-fire
    // -----------------------------------------------------------------
    await step(
      'data-trigger-bootstrap-no-fire',
      'Clone doc-text-extractor with every="* * * * *", publish, wait through >=1 tick -> confirm the bootstrap evaluate() sets the cursor WITHOUT firing (condition.ts:227 "the bootstrap pull intentionally never fires")',
      async () => {
        const { appId: _appId, name } = await cloneAndSpeedUpTrigger(
          TEMPLATE_DATA_ID,
          DATA_AUTOMATION_SUBFOLDER,
          '* * * * *',
        );
        dataName = name;

        await openAutomationView(name);
        await shot('05-data-view-before-bootstrap');
        const kindEyebrow = page.locator('[class*="heroKind"]');
        await kindEyebrow.waitFor({ state: 'visible', timeout: 10_000 });
        const kindText = (await kindEyebrow.textContent())?.trim() ?? '';
        console.log(
          `[auto04] data-trigger automation hero kindEyebrow: ${JSON.stringify(kindText)}`,
        );
        assert(
          /data trigger/i.test(kindText),
          `expected the hero eyebrow to honestly say "Data trigger", got ${JSON.stringify(kindText)}`,
        );

        dataRef = await gwFindRef(name);
        assert(Boolean(dataRef), `expected "${name}" to be a real gateway row after clone+publish`);

        // Wait through >=1 full minute boundary with margin (75s) -- same
        // convention as flows-automations-02-triggers.mjs's
        // cron-disabled-no-fire flow. No new core.content_item write has
        // happened yet, so even if the scheduler ticks multiple times in
        // this window, evaluateDataTrigger's bootstrap gate (cursor===null
        // on the FIRST tick, then "no NEW changes" on any later tick) must
        // keep firing at bay.
        await page.waitForTimeout(75_000);
        const runsAfterBootstrapWait = await gwRuns(dataRef);
        console.log(
          `[auto04] "${name}" run count after a 75s bootstrap-only wait (no new write yet): ${runsAfterBootstrapWait.length}`,
        );
        await shot('06-data-view-after-bootstrap-wait-zero-runs');
        assert(
          runsAfterBootstrapWait.length === 0,
          `expected ZERO runs from the bootstrap tick(s) (cursor set, no fire) -- got ${runsAfterBootstrapWait.length}: ${JSON.stringify(runsAfterBootstrapWait)}`,
        );
        console.log(
          '[auto04] CONFIRMED: the bootstrap evaluate() call set the trigger cursor without firing -- no false-positive on pre-existing (zero) state.',
        );
      },
    );

    // -----------------------------------------------------------------
    // FLOW: data-trigger-real-fire-after-write
    // -----------------------------------------------------------------
    await step(
      'data-trigger-real-fire-after-write',
      'Install Docs, upload a real file (core.add_document -> ctx.wrote("core.content_item", ...)) -- a GENUINE post-bootstrap write -- then wait for the next tick and confirm a run lands with triggerOrigin:"data"',
      async () => {
        assert(
          Boolean(dataRef) && Boolean(dataName),
          'need the bootstrapped data-trigger automation from the previous flow',
        );

        await installDocsApp();
        await shot('07-docs-installed');
        await openDocsApp();
        const fl = docsFrame();
        const pngPath = await writeUploadFixture();
        const fileInput = fl.locator('#uploadInput');
        await fileInput.setInputFiles([pngPath]);
        await fl.locator('.d-card').first().waitFor({ state: 'visible', timeout: 20_000 });
        const cardCount = await fl.locator('.d-card').count();
        console.log(`[auto04] Docs cards after real upload: ${cardCount}`);
        assert(cardCount >= 1, `expected >=1 doc card after uploading, got ${cardCount}`);
        await shot('08-docs-real-upload-landed');
        console.log(
          '[auto04] real core.content_item write landed via the Docs app UI (not sqlite surgery) -- this is the genuine post-bootstrap write the gap called for.',
        );

        // Poll for the next tick's fire -- same polling shape as the
        // condition flow above and flows-automations-02-triggers.mjs's
        // cron-real-fire flow.
        const deadline = Date.now() + 150_000;
        let found = null;
        while (Date.now() < deadline) {
          const runs = await gwRuns(dataRef);
          found = runs.find((r) => r.triggerOrigin === 'data') ?? null;
          if (found) break;
          await page.waitForTimeout(10_000);
        }
        console.log(`[auto04] data-trigger run search result: ${JSON.stringify(found)}`);
        assert(
          Boolean(found),
          `expected a real triggerOrigin:'data' run within 150s of a genuine new core.content_item write, got runs=${JSON.stringify(await gwRuns(dataRef))}`,
        );
        console.log(
          `[auto04] CONFIRMED real data-trigger fire: run ${found.runId} ok=${found.ok} error=${found.error ?? 'none'} -- the fire itself is proven regardless of whether the handler's ctx.agent (LLM) call inside doc-text-extractor succeeded (condition.ts's fire decision precedes the handler entirely).`,
        );

        await openAutomationView(dataName);
        await shot('09-data-view-after-real-fire');
        const runRows = page.locator('button[data-ok]');
        const rowCount = await runRows.count();
        assert(
          rowCount >= 1,
          `expected >=1 run row on the data-trigger automation's view, got ${rowCount}`,
        );
        const rowText = await runRows.first().textContent();
        console.log(
          `[auto04] first run row text: ${JSON.stringify(rowText.replace(/\n/g, ' | '))}`,
        );
        assert(
          /data/i.test(rowText),
          `expected the run row to visibly say "Data", got: ${rowText}`,
        );
        await runRows.first().click();
        await page.waitForTimeout(1000);
        await shot('10-data-run-view-detail');
        note(
          'GAP #2 CLOSED: doc-text-extractor\'s data trigger was driven through the FULL bootstrap-then-real-fire path -- (a) a bootstrap tick with zero pre-existing matches produced ZERO runs (proving the "first eval only sets the watermark" behavior), (b) a genuine new core.content_item row was produced through the REAL Docs app UI (not out-of-band SQL), and (c) the NEXT tick produced a real triggerOrigin="data" run, honestly labeled "Data" in the UI.',
        );
      },
    );

    // -----------------------------------------------------------------
    // FLOW: concurrent-cron-same-tick
    // -----------------------------------------------------------------
    await step(
      'concurrent-cron-same-tick',
      'Two independent every-minute cron automations, created via the (legitimate, non-rejected) POST /centraid/_automations route -- both fire in the SAME tick window, no crash, no dropped run',
      async () => {
        const bodyA = {
          id: CRON_A_ID,
          name: CRON_A_NAME,
          triggers: [{ expr: '* * * * *' }],
          enabled: true,
          publish: true,
        };
        const bodyB = {
          id: CRON_B_ID,
          name: CRON_B_NAME,
          triggers: [{ expr: '* * * * *' }],
          enabled: true,
          publish: true,
        };
        const [resA, resB] = await Promise.all([
          gwFetch('/centraid/_automations', { method: 'POST', body: bodyA }),
          gwFetch('/centraid/_automations', { method: 'POST', body: bodyB }),
        ]);
        console.log(
          `[auto04] create A: status=${resA.status} row=${JSON.stringify(resA.json?.row)}`,
        );
        console.log(
          `[auto04] create B: status=${resB.status} row=${JSON.stringify(resB.json?.row)}`,
        );
        assert(
          resA.status === 201 && resB.status === 201,
          `expected both creates to succeed, got A=${resA.status} B=${resB.status}`,
        );
        const refA = resA.json.row.ref;
        const refB = resB.json.row.ref;

        await openAutomationsOverview();
        await page
          .getByRole('button', { name: new RegExp(esc(CRON_A_NAME)) })
          .first()
          .waitFor({ state: 'visible', timeout: 10_000 });
        await page
          .getByRole('button', { name: new RegExp(esc(CRON_B_NAME)) })
          .first()
          .waitFor({ state: 'visible', timeout: 10_000 });
        await shot('11-concurrent-cron-overview');

        const deadline = Date.now() + 150_000;
        let runA = null;
        let runB = null;
        while (Date.now() < deadline) {
          const [runsA, runsB] = await Promise.all([gwRuns(refA), gwRuns(refB)]);
          runA = runsA.find((r) => r.triggerOrigin === 'cron') ?? null;
          runB = runsB.find((r) => r.triggerOrigin === 'cron') ?? null;
          if (runA && runB) break;
          await page.waitForTimeout(10_000);
        }
        console.log(`[auto04] runA=${JSON.stringify(runA)} runB=${JSON.stringify(runB)}`);
        assert(
          Boolean(runA),
          `expected automation A to get a cron run, got none: ${JSON.stringify(await gwRuns(refA))}`,
        );
        assert(
          Boolean(runB),
          `expected automation B to get a cron run, got none: ${JSON.stringify(await gwRuns(refB))}`,
        );

        const deltaMs = Math.abs(runA.startedAt - runB.startedAt);
        console.log(
          `[auto04] A.startedAt=${runA.startedAt} B.startedAt=${runB.startedAt} delta=${deltaMs}ms`,
        );
        // Both automations are registered in the SAME scheduler entries map
        // and tick() iterates it synchronously within one wall-clock-minute
        // callback (in-process-scheduler.ts tick()) -- their fires should
        // land within the same minute, generously bounded at 65s to allow
        // for either landing on the tick right before/after the boundary if
        // they were created a hair apart.
        assert(
          deltaMs < 65_000,
          `expected both cron runs to land in the SAME tick window (<65s apart), got ${deltaMs}ms apart`,
        );

        const crashed = await page.evaluate(() => document.title).catch(() => null);
        assert(crashed !== null, 'page appears to have crashed after two same-tick cron fires');

        await openAutomationView(CRON_A_NAME);
        await shot('12-cron-a-after-fire');
        await openAutomationView(CRON_B_NAME);
        await shot('13-cron-b-after-fire');

        note(
          `concurrent-cron-same-tick: automation A run ${runA.runId} and automation B run ${runB.runId} landed ${deltaMs}ms apart -- both triggerOrigin="cron", no crash, no run silently dropped.`,
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
    console.log('\n================ AUTOMATIONS TRIGGER-FIRES VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(36)} ${r.label} (${r.ms}ms)`);
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
      console.log('\nAll automations-trigger-fires steps PASSED.');
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
