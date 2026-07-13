#!/usr/bin/env node
// governance: allow-repo-hygiene file-size-limit (#363) single coherent multi-step live-app QA scenario against the real Electron+gateway rig; splitting mid-scenario would fragment one flow across files with no readability gain
// Automations lifecycle QA suite: adopt-from-template, view screen, run-now +
// timeline, run history (3 runs, open an older one), enable/disable, "New
// automation" from scratch, edit-in-builder, delete (cancel then confirm),
// relaunch persistence.
//
// SELECTOR NOTE: the brief that seeded this suite named `.cd-au-*` classes
// (`.cd-au-ov-*`, `.cd-au-view`, `.cd-au-switch`, `.cd-au-btn-primary`, etc).
// Those don't exist in the current renderer -- AutomationsOverviewScreen.tsx /
// AutomationThreadScreen.tsx / AutomationEditorScreen.tsx / RunViewScreen.tsx
// all use Vite CSS Modules (generateScopedName: '[name]__[local]__[hash:base64:5]',
// see apps/desktop/vite.config.ts:36-38), so a class like `.run` compiles to
// something like `AutomationThreadScreen__run__a1B2c` at runtime -- there is
// no stable literal `cd-au-*` string anywhere. This suite instead uses, in
// order of preference: (1) real ARIA roles/names (heading, dialog, switch,
// tab, radio), (2) literal `title`/`aria-label`/`data-*` attributes the
// source hard-codes verbatim (confirmed by reading AutomationThreadScreen.tsx,
// AutomationEditorScreen.tsx, RunViewScreen.tsx, AutomationsOverviewScreen.tsx,
// confirm.ts), and (3) the repo's own `[class*="substring"]` CSS-module
// convention only where no semantic attribute exists.
//
// UPDATED CONTRACT (Automations UI revamp -- receipts/issue-387-automations-ui-revamp.md):
//   - Adopting a template (Discover/Templates "Use template") now lands on
//     the automation THREAD (route `automation-view`, AutomationThreadScreen)
//     instead of the builder. Thread signature: crumb button "Automations",
//     `h1` = automation name, status pill `[data-au-status]`, enable switch
//     still `input[role="switch"]` wrapped in `label:has(input[role="switch"])`,
//     buttons "Run now" (plain, NOT "Delete <name>") / "Edit" (plain, NOT
//     `button[title="Edit in builder"]`) / "Delete" (plain). "Edit" now opens
//     the EDITOR (route `automation-editor`), not the builder.
//   - "Run now" on the thread does NOT navigate -- it stays on the thread and
//     the fired run appears as a `button[data-run-status]` timeline entry
//     (values ok/fail/running) via bounded polling. A run's row carries
//     `data-run-status` on BOTH the outer `<button>` and an inner
//     `<span class="entryDot">` -- always scope to `button[data-run-status]`
//     when counting/clicking, or a plain `[data-run-status]` locator
//     double-counts. Click an entry to navigate to the (unchanged) run-view.
//     Entries render OLDEST-FIRST within each date group (top-to-bottom, like
//     a growing conversation) -- the INVERSE of the old newest-first feed --
//     so "the oldest run" is now `.first()`, not `.last()`.
//   - "New automation" now opens the instructions-first EDITOR (route
//     `automation-editor`, create mode) instead of scaffolding a gateway row
//     and jumping straight to the builder. NO gateway row exists until the
//     editor's "Create automation" button is clicked. The editor: labeled
//     "Name" input, labeled "Instructions" textarea, a trigger picker
//     `role="radiogroup"` with `role="radio"` cards ("Schedule"/"Webhook"/
//     "Condition"/"Data"; Schedule reveals a mono cron-expression input),
//     tabs `role="tab"` ("Connectors"/"Behavior"/"Notifications"), footer
//     "Cancel" + "Create automation". Saving hands off to the SAME builder
//     chat as before, seeded with the typed instructions as the first
//     auto-sent user message (no manual paste-and-Send needed).
//   - The old "Next 3 runs" hero block is gone -- the thread's cron trigger
//     chip shows the raw cron expression plus a single "next <relative
//     label>" hint (`header.nextRuns[0]` only), not a 3-item list.
//   - The old per-view "Cron" run-history filter (`button[data-filter="cron"]`)
//     no longer exists -- the thread has no filter controls at all.
//
// Run with: node apps/desktop/tests/e2e-live/flows-automations-01-lifecycle.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-automations-01');

const TEMPLATE_NAME = 'Trip albums';

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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-auto01-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `auto01-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function bodyText() {
  return page.evaluate(() => document.body.textContent);
}

/** Out-of-band gateway fetch, same pattern as flows-approvals-02-corner-cases.mjs
 *  (window.CentraidApi.getGatewayAuth() + a raw fetch, bypassing the UI). */
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

async function gwListAutomations() {
  const { json } = await gwFetch('/centraid/_automations');
  return json?.rows ?? [];
}

async function gwFindRef(name) {
  const rows = await gwListAutomations();
  const row = rows.find((r) => r.name === name);
  return row?.ref ?? null;
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

async function adoptTemplate(templateName) {
  await navTo(page, 'Discover');
  await page.getByRole('tab', { name: /^Automations/ }).click();
  await page.waitForTimeout(200);
  const card = page.locator('button[data-kind="automation"]', { hasText: templateName }).first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await card.click();
  const dialog = page.getByRole('dialog', { name: new RegExp(templateName) });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await shot('adopt-preview-dialog');
  await dialog.getByRole('button', { name: 'Use template' }).click();
  // Adopting an automation template now navigates straight to its THREAD
  // (AutomationThreadScreen, route `automation-view`), not the builder --
  // TemplatesRoute.tsx/DiscoverRoute.tsx `useAutoTemplate`/`applyAutoTemplate`
  // both `navigate({ kind: 'automation-view', automationId: ref })` after the
  // clone. "Run now" is the thread's own unambiguous, always-present marker
  // (no webhook-reveal race for this suite's templates, unlike suite 02).
  await page
    .getByRole('button', { name: /Run now|Starting…/ })
    .waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(500);
  await shot('adopt-after-use-template-thread');
}

async function runNowFromViewScreen() {
  // "Run now" on the thread does NOT navigate -- it fires and stays on the
  // thread; the run shows up as a `button[data-run-status]` timeline entry
  // via the screen's own bounded poll loop (AutomationThreadScreen.tsx).
  const runBtn = page.getByRole('button', { name: /Run now|Starting…/ });
  await runBtn.waitFor({ state: 'visible', timeout: 5_000 });
  await runBtn.click();
  await page.waitForTimeout(1500);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const t0 = Date.now();
  session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  page.setDefaultTimeout(60_000);
  console.log(`[auto01] launched (fresh vault) + Home ready in ${Date.now() - t0}ms`);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    // ---------------------------------------------------------------------
    // FLOW 1: adopt-template
    // ---------------------------------------------------------------------
    await step(
      'flow1-adopt-template',
      'Discover -> Automations tab -> adopt "Trip albums" -> on Home AND Automations overview',
      async () => {
        await adoptTemplate(TEMPLATE_NAME);

        await navTo(page, 'Home');
        await page
          .getByRole('heading', { name: 'What should we build?' })
          .waitFor({ state: 'visible', timeout: 15_000 });
        const homeCard = page
          .locator('button[data-kind="automation"]', { hasText: TEMPLATE_NAME })
          .first();
        await homeCard.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('01-home-autocard');

        await openAutomationsOverview();
        const ovRow = page.getByRole('button', { name: new RegExp(TEMPLATE_NAME) }).first();
        await ovRow.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('01-overview-with-automation');

        const rows = await gwListAutomations();
        const row = rows.find((r) => r.name === TEMPLATE_NAME);
        assert(
          Boolean(row),
          `expected a gateway automation row named "${TEMPLATE_NAME}" after adopt, rows: ${JSON.stringify(rows.map((r) => r.name))}`,
        );
        console.log(
          `[auto01] adopted ref=${row.ref} enabled=${row.enabled} triggers=${JSON.stringify(row.triggers)}`,
        );
      },
    );

    // ---------------------------------------------------------------------
    // FLOW 2: view-screen
    // ---------------------------------------------------------------------
    await step(
      'flow2-view-screen',
      'Automation thread screen: header (name, cron trigger chip since template has no webhook), enable switch, Run now/Edit/Delete',
      async () => {
        await openAutomationView(TEMPLATE_NAME);
        await shot('02-view-screen');

        const bodyTxt = await bodyText();
        // packages/blueprints/automations/trip-albums/automations/trip-albums/automation.json
        // declares a single `cron` trigger ("0 6 * * *"), no webhook -- so
        // the trigger-chips row should render the cron expr + "next <label>"
        // hint (TriggerChips in AutomationThreadScreen.tsx), not a webhook
        // URL. The old "NEXT 3 RUNS" hero block is gone in the revamp --
        // only `header.nextRuns[0]` renders, as "next <relative label>".
        assert(
          /0 6 \* \* \*/.test(bodyTxt),
          `expected cron expr "0 6 * * *" in the trigger chip, got body head: ${bodyTxt.slice(0, 300)}`,
        );
        assert(
          /next\s/i.test(bodyTxt),
          'expected a "next <relative label>" hint next to the cron trigger chip',
        );
        assert(
          !/Provisioning endpoint/.test(bodyTxt),
          'unexpected webhook-provisioning UI for a cron-only automation',
        );

        // The native checkbox is the standard visually-hidden-input pattern
        // (AutomationThreadScreen.module.css `.switch input { opacity: 0;
        // width: 0; height: 0; }`, styled sibling `.switchTrack` is what's
        // actually painted) -- it's real and `attached`, just never
        // Playwright-"visible" (0x0 box), so wait for `attached`, not `visible`.
        const sw = page.locator('input[role="switch"]');
        await sw.waitFor({ state: 'attached', timeout: 5_000 });
        const checked = await sw.getAttribute('aria-checked');
        console.log(
          `[auto01] enable switch aria-checked=${checked} (template default is enabled:false)`,
        );
        assert(
          checked === 'false',
          `expected freshly-adopted automation to start disabled (template default), got aria-checked=${checked}`,
        );

        const runBtn = page.getByRole('button', { name: /Run now|Starting…/ });
        await runBtn.waitFor({ state: 'visible', timeout: 5_000 });

        // "Edit" (plain label, no title attr) now opens the EDITOR, not the
        // builder -- AutomationThreadScreen.tsx's header actions. "Delete" is
        // also a plain label (not "Delete <name>") -- the automation's name
        // only appears in the confirm dialog's message, not the button text.
        const editBtn = page.getByRole('button', { name: 'Edit', exact: true });
        await editBtn.waitFor({ state: 'visible', timeout: 5_000 });
        const deleteBtn = page.getByRole('button', { name: 'Delete', exact: true });
        await deleteBtn.waitFor({ state: 'visible', timeout: 5_000 });
      },
    );

    // ---------------------------------------------------------------------
    // FLOW 3: run-now-and-timeline
    // ---------------------------------------------------------------------
    await step(
      'flow3-run-now-and-timeline',
      'Run now (stays on thread) -> the run appears as a timeline entry -> open it -> run viewer renders a resolved final node; expand a node (or Log mode if no tool nodes)',
      async () => {
        await runNowFromViewScreen();
        await shot('03-thread-after-run-now-click');

        // "Run now" no longer navigates (AutomationThreadScreen.tsx doRun) —
        // the fire is async (202), so the thread's own bounded poll loop
        // surfaces the run as a `button[data-run-status]` timeline entry.
        // MUST scope to the `button` tag: the entry's inner `.entryDot` span
        // also carries `data-run-status`, so a bare `[data-run-status]`
        // locator double-counts every run.
        const entries = page.locator('button[data-run-status]');
        await entries.first().waitFor({ state: 'visible', timeout: 30_000 });
        await shot('03-thread-run-entry-appeared');

        // Entries render oldest-first within a date group (top-to-bottom,
        // like a growing conversation) — the just-fired run is the LAST one.
        await entries.last().click();
        await page.waitForTimeout(500);
        await shot('03-run-view-after-click');

        // Poll for the final timeline node to leave "running"/"pending" —
        // RunViewScreen only stamps `data-status` inside the run view
        // (trigger item, per-node items, final item), so `[data-status]` is
        // unambiguous on this screen.
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
        console.log(`[auto01] final timeline node data-status after settle: ${finalStatus}`);
        await shot('03-run-view-timeline-collapsed');
        assert(
          finalStatus === 'ok' || finalStatus === 'fail',
          `run did not resolve within 30s, stuck at data-status=${finalStatus}`,
        );

        if (finalStatus === 'fail') {
          const errTxt = (await bodyText()).slice(0, 600);
          console.log(
            `[auto01] WARNING: run resolved as FAIL -- capturing body for root-cause: ${errTxt}`,
          );
        }

        // Expand a timeline node if any tool-call nodes exist between the
        // trigger and the final card. IMPORTANT: don't use a bare
        // `[aria-expanded]` selector here -- the sidebar's ProfileSwitcherHead
        // button (vault switcher trigger) ALSO always renders
        // `aria-expanded="false"|"true"` (ProfileSwitcherHead.tsx:64) even
        // when closed, so an unscoped `[aria-expanded]` locator's `.first()`
        // silently grabs that button instead of a real timeline node, clicks
        // it, and pops the vault-switcher overlay open -- which then blocks
        // every subsequent sidebar click for the rest of the run (confirmed:
        // this is exactly what happened on the first pass of this suite).
        // TimelineNode heads carry the CSS-module class local-named "tlHead"
        // (RunViewScreen.tsx:54), which compiles to
        // "RunViewScreen__tlHead__<hash>". MUST scope to `button` too: the
        // final card's static header div uses local name "tlHeadStatic"
        // (RunViewScreen.tsx:349, `cx(styles.tlHead, styles.tlHeadStatic)`)
        // which, compiled, is a SEPARATE class token that still contains the
        // substring "tlHead" ("...tlHeadStatic...") -- an unscoped
        // `[class*="tlHead"]` matches that inert `<div>` too and, on a run
        // with zero real tool-call nodes, is the ONLY match, so `.first()`
        // silently clicks a static div with no aria-expanded/click handler
        // (confirmed: this is what happened on pass 2 of this suite).
        const nodeHeads = page.locator('button[class*="tlHead"]');
        const nodeCount = await nodeHeads.count();
        console.log(
          `[auto01] expandable timeline node heads (excludes trigger/final): ${nodeCount}`,
        );
        if (nodeCount > 0) {
          await nodeHeads.first().click();
          await page.waitForTimeout(300);
          const expandedAttr = await nodeHeads.first().getAttribute('aria-expanded');
          assert(expandedAttr === 'true', 'expected node aria-expanded=true after click');
          await shot('03-run-view-timeline-expanded');
        } else {
          console.log(
            '[auto01] no intermediate tool-call nodes (health-check automation is a plain LLM turn) -- switching to Log mode to verify expandable content there',
          );
          await page.getByRole('tab', { name: 'Log' }).click();
          await page.waitForTimeout(300);
          await shot('03-run-view-log-mode');
          // LogRow's args/output chips use CSS-module class local-named
          // "logChip" (RunViewScreen.tsx:116,131) -- same substring-scoping
          // rationale as tlHead above, avoids the vault-switcher trap too.
          const logChips = page.locator('button[class*="logChip"]');
          const logChipCount = await logChips.count();
          console.log(`[auto01] Log-mode expandable chips (args/output): ${logChipCount}`);
          if (logChipCount > 0) {
            await logChips.first().click();
            await page.waitForTimeout(200);
            await shot('03-run-view-log-mode-expanded');
          }
          await page.getByRole('tab', { name: 'Timeline' }).click();
          await page.waitForTimeout(200);
        }
      },
    );

    // ---------------------------------------------------------------------
    // FLOW 4: runs-history
    // ---------------------------------------------------------------------
    let olderRunId = null;
    await step(
      'flow4-runs-history',
      'Run 2 more times (3 total); run history lists 3; opening an OLDER run still renders its timeline',
      async () => {
        for (let i = 2; i <= 3; i++) {
          await openAutomationView(TEMPLATE_NAME);
          await runNowFromViewScreen();
          await page.waitForTimeout(2500);
          console.log(`[auto01] fired run #${i}`);
        }

        await openAutomationView(TEMPLATE_NAME);
        await shot('04-view-after-3-runs');

        // `button[data-run-status]` (see flow3 note — must scope to `button`,
        // the inner `.entryDot` span duplicates the attribute).
        const runRows = page.locator('button[data-run-status]');
        const runRowCount = await runRows.count();
        console.log(`[auto01] run-history rows visible on automation thread: ${runRowCount}`);
        assert(runRowCount === 3, `expected 3 run-history rows after 3 runs, got ${runRowCount}`);

        const rows = await gwListAutomations();
        const ref = rows.find((r) => r.name === TEMPLATE_NAME)?.ref;
        const { json: runsJson } = await gwFetch(
          `/centraid/_automations/runs?ref=${encodeURIComponent(ref)}&limit=50`,
        );
        const runs = runsJson?.runs ?? [];
        console.log(
          `[auto01] gateway runs for ${ref}: ${runs.length} (ids: ${runs.map((r) => r.runId).join(', ')})`,
        );
        assert(runs.length === 3, `expected 3 runs in the gateway ledger, got ${runs.length}`);
        // Oldest run = last in the gateway's newest-first API feed.
        olderRunId = runs[runs.length - 1]?.runId ?? null;
        assert(Boolean(olderRunId), 'could not determine an older runId to open from history');

        // Open the OLDEST run row from the UI, not by URL — exercises the
        // actual click path. UNLIKE the old newest-first feed, the thread's
        // entries render OLDEST-FIRST top-to-bottom (AutomationThreadScreen.tsx
        // groupRuns sorts ascending by startedAt), so the oldest run is now
        // `.first()`, not `.last()`.
        await runRows.first().click();
        await page.waitForTimeout(1000);
        await shot('04-older-run-view');
        const finalNodes = page.locator('[data-status]');
        await finalNodes.first().waitFor({ state: 'visible', timeout: 10_000 });
        const lastStatus = await finalNodes.last().getAttribute('data-status');
        console.log(`[auto01] older run's final node data-status: ${lastStatus}`);
        assert(
          lastStatus === 'ok' || lastStatus === 'fail',
          `older run did not render a resolved timeline, data-status=${lastStatus}`,
        );
      },
    );

    // ---------------------------------------------------------------------
    // FLOW 5: disable-enable
    // ---------------------------------------------------------------------
    await step(
      'flow5-disable-enable',
      'Toggle enable switch on -> verify + gateway enabled:true; off -> verify + gateway enabled:false',
      async () => {
        await openAutomationView(TEMPLATE_NAME);
        // Same visually-hidden-input pattern as flow2 -- wait for `attached`,
        // and click the `<label>` wrapper (real painted box) instead of the
        // 0x0 `<input>` itself.
        const sw = page.locator('input[role="switch"]');
        await sw.waitFor({ state: 'attached', timeout: 5_000 });
        const switchLabel = page.locator('label:has(input[role="switch"])');
        const initial = await sw.getAttribute('aria-checked');
        console.log(`[auto01] switch state entering flow5: aria-checked=${initial}`);

        async function clickSwitch() {
          await switchLabel.click({ timeout: 5_000 });
        }

        // ---- turn ON ----
        await clickSwitch();
        await page.waitForTimeout(600);
        await shot('05-after-toggle-on');
        let checked = await sw.getAttribute('aria-checked');
        assert(checked === 'true', `expected aria-checked=true after enabling, got ${checked}`);
        let ref = await gwFindRef(TEMPLATE_NAME);
        let { json } = await gwFetch(`/centraid/_automations/read?ref=${encodeURIComponent(ref)}`);
        console.log(`[auto01] gateway row after enable: enabled=${json?.row?.enabled}`);
        assert(
          json?.row?.enabled === true,
          `expected gateway enabled:true after enabling, got ${JSON.stringify(json?.row?.enabled)}`,
        );

        // ---- turn OFF ----
        await clickSwitch();
        await page.waitForTimeout(600);
        await shot('05-after-toggle-off');
        checked = await sw.getAttribute('aria-checked');
        assert(checked === 'false', `expected aria-checked=false after disabling, got ${checked}`);
        ({ json } = await gwFetch(`/centraid/_automations/read?ref=${encodeURIComponent(ref)}`));
        console.log(`[auto01] gateway row after disable: enabled=${json?.row?.enabled}`);
        assert(
          json?.row?.enabled === false,
          `expected gateway enabled:false after disabling, got ${JSON.stringify(json?.row?.enabled)}`,
        );

        // ---- turn back ON, leave enabled for the rest of the suite ----
        await clickSwitch();
        await page.waitForTimeout(600);
        checked = await sw.getAttribute('aria-checked');
        assert(checked === 'true', `expected aria-checked=true after re-enabling, got ${checked}`);
        await shot('05-final-enabled');
      },
    );

    // ---------------------------------------------------------------------
    // FLOW 6: create-new-automation
    // ---------------------------------------------------------------------
    const NEW_AUTO_NAME = 'GitHub issues digest';
    const NEW_AUTO_INSTRUCTIONS = "Every weekday morning, summarize yesterday's new GitHub issues.";
    await step(
      'flow6-create-new-automation',
      '"New automation" from overview -> instructions-first EDITOR (create mode, no draft row yet) -> fill Name/Instructions/Schedule trigger -> Create automation -> hands off to the builder, seeded with the instructions as the first auto-sent message',
      async () => {
        await openAutomationsOverview();
        // .first() -- the empty-state overview repeats "New automation" as
        // BOTH a header action and its own empty-state CTA
        // (AutomationsOverviewScreen.tsx EmptyState); scope defensively even
        // though by this point in the suite the fleet is non-empty.
        const newBtn = page.getByRole('button', { name: 'New automation' }).first();
        await newBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await newBtn.click();

        // AutomationsRoute.tsx onNewAutomation -> navigate({kind:'automation-editor'})
        // (create mode, no automationId/templateId) -- AutomationEditorRoute.tsx's
        // loadData returns mode:'create' with NO gateway row; unlike the old
        // scaffoldAutomationDraft() flow, nothing is minted on the gateway
        // until "Create automation" is clicked below.
        const nameInput = page.getByLabel('Name', { exact: true });
        await nameInput.waitFor({ state: 'visible', timeout: 15_000 });
        const instructionsField = page.getByLabel('Instructions', { exact: true });
        await instructionsField.waitFor({ state: 'visible', timeout: 5_000 });
        await shot('06-new-automation-editor-opened');

        const rowsBeforeCreate = await gwListAutomations();
        const preexisting = rowsBeforeCreate.find((r) => r.name === NEW_AUTO_NAME);
        console.log(
          `[auto01] gateway row named "${NEW_AUTO_NAME}" before Create automation is clicked: ${Boolean(preexisting)} (expected false -- create-mode no longer scaffolds eagerly)`,
        );
        assert(
          !preexisting,
          `expected NO gateway row for "${NEW_AUTO_NAME}" before saving the editor, found one: ${JSON.stringify(preexisting)}`,
        );

        await nameInput.fill(NEW_AUTO_NAME);
        await instructionsField.fill(NEW_AUTO_INSTRUCTIONS);

        // Trigger picker: role="radiogroup" of role="radio" cards
        // (AutomationEditorScreen.tsx TriggerCard) -- pick "Schedule" and
        // fill a weekday-morning cron expr matching the instructions.
        await page.getByRole('radio', { name: 'Schedule' }).click();
        await page.waitForTimeout(150);
        const cronInput = page.getByPlaceholder('0 7 * * *');
        await cronInput.waitFor({ state: 'visible', timeout: 5_000 });
        await cronInput.fill('0 8 * * 1-5');
        await shot('06-new-automation-editor-filled');

        await page.getByRole('button', { name: 'Create automation', exact: true }).click();

        // onSave -> createAutomation(..., publish:true) mints the REAL row,
        // then (create mode) onOpenBuilder(instructions) navigates to the
        // SAME builder chat as before, with the typed instructions seeded as
        // `initialPrompt` -- useBuilder.ts auto-sends it, no manual
        // fill+Send needed.
        await page
          .getByRole('button', { name: 'Config' })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForTimeout(500);
        await shot('06-new-automation-builder-opened');

        const rowsAfterCreate = await gwListAutomations();
        const createdRow = rowsAfterCreate.find((r) => r.name === NEW_AUTO_NAME);
        console.log(
          `[auto01] gateway row present after "Create automation": ${Boolean(createdRow)} ref=${createdRow?.ref}`,
        );
        assert(
          Boolean(createdRow),
          `expected "${NEW_AUTO_NAME}" to exist as a real gateway row after clicking Create automation`,
        );

        // The instructions typed in the editor must show up as the FIRST
        // user message in the builder chat (BuilderChatPane.tsx `.user
        // .userBubble`), proving the seed actually reached the chat and
        // auto-sent rather than just pre-filling an empty composer.
        const firstUserBubble = page.locator('[class*="userBubble"]').first();
        await firstUserBubble.waitFor({ state: 'visible', timeout: 15_000 });
        const firstUserText = (await firstUserBubble.textContent())?.trim() ?? '';
        console.log(
          `[auto01] first user message in the seeded builder chat: ${JSON.stringify(firstUserText)}`,
        );
        // The editor frames the seed as an explicit compile work order (the
        // raw instructions are already the manifest `prompt`); the
        // instructions must ride inside it verbatim.
        assert(
          firstUserText.startsWith('Compile this automation now') &&
            firstUserText.includes(NEW_AUTO_INSTRUCTIONS),
          `expected the builder chat's first user message to be the compile work order carrying the editor's instructions, got ${JSON.stringify(firstUserText)}`,
        );

        // BUG CHECK (informational, not a failing assertion here -- see
        // flow7 below and flows-automations-06-builder-to-run.mjs for the
        // load-bearing repro/documentation): AutomationEditorRoute.tsx's
        // onOpenBuilder passes the COMPOUND automation ref as
        // `automation-builder`'s `automationId`, which useBuilder.ts/
        // BuilderRoute.tsx expect to be the BARE app id -- the tell is
        // BuilderAutomationPane's Config tab stuck on "Loading automation…"
        // forever (automationRow.current never resolves against the
        // mismatched appId).
        const stuckLoadingFlow6 = await page
          .getByText('Loading automation…', { exact: true })
          .count();
        console.log(
          `[auto01] BUG CHECK: Config tab stuck on "Loading automation…" right after New-automation create: ${stuckLoadingFlow6 > 0}`,
        );

        // Best-effort: wait for a "thinking" bubble to appear then clear, or
        // just document however far it gets within a bounded window (per
        // task brief, a full LLM build loop is not required here).
        const deadline = Date.now() + 30_000;
        let sawThinking = false;
        while (Date.now() < deadline) {
          const thinkingCount = await page.locator('[class*="chatThinking"]').count();
          if (thinkingCount > 0) sawThinking = true;
          if (thinkingCount === 0 && sawThinking) break;
          await page.waitForTimeout(1000);
        }
        console.log(
          `[auto01] saw a "thinking" bubble during New-automation prompt: ${sawThinking}`,
        );
        await shot('06-new-automation-after-progress-wait');
        const errs = consoleMessages.filter((m) => m.type === 'error');
        console.log(`[auto01] console errors so far after New-automation prompt: ${errs.length}`);
      },
    );

    // ---------------------------------------------------------------------
    // FLOW 7: edit-in-builder
    // ---------------------------------------------------------------------
    await step(
      'flow7-edit-in-builder',
      '"Edit" on the thread -> instructions-first EDITOR (edit mode, existing Name/Instructions/cron pre-filled) -> its own "Open builder chat" -> builder opens seeded with the existing config',
      async () => {
        await openAutomationView(TEMPLATE_NAME);
        // "Edit" now opens the EDITOR, not the builder directly
        // (AutomationThreadScreen.tsx onEdit -> navigate({kind:'automation-editor'})).
        const editBtn = page.getByRole('button', { name: 'Edit', exact: true });
        await editBtn.waitFor({ state: 'visible', timeout: 5_000 });
        await editBtn.click();

        // Edit mode: labeled Name/Instructions pre-filled from the loaded
        // row, cron expr visible in the selected "Schedule" trigger card.
        const nameInput = page.getByLabel('Name', { exact: true });
        await nameInput.waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForTimeout(300);
        await shot('07-editor-edit-mode-opened');

        const nameValue = await nameInput.inputValue();
        console.log(`[auto01] editor Name field on edit-mode load: ${JSON.stringify(nameValue)}`);
        assert(
          nameValue === TEMPLATE_NAME,
          `expected the editor's Name field to be pre-filled with "${TEMPLATE_NAME}", got ${JSON.stringify(nameValue)}`,
        );
        // The cron expr lives inside the Schedule trigger card's `<input
        // value=...>` (AutomationEditorScreen.tsx) -- an input's value is a
        // DOM property, never part of `document.body.textContent`, so it
        // must be read via `inputValue()`, not a body-text regex.
        const cronExprInput = page.getByPlaceholder('0 7 * * *');
        await cronExprInput.waitFor({ state: 'visible', timeout: 5_000 });
        const cronExprValue = await cronExprInput.inputValue();
        console.log(
          `[auto01] editor cron-expr field on edit-mode load: ${JSON.stringify(cronExprValue)}`,
        );
        assert(
          cronExprValue === '0 6 * * *',
          `expected the editor's Schedule trigger card to pre-fill the existing cron expr "0 6 * * *", got ${JSON.stringify(cronExprValue)}`,
        );

        // Edit mode's own "Open builder chat" header action (AutomationEditorScreen.tsx) --
        // hands off to the SAME builder as before, this time with NO seed
        // message (existing automation, nothing new to compile yet).
        await page.getByRole('button', { name: 'Open builder chat', exact: true }).click();
        await page
          .getByRole('button', { name: 'Config' })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForTimeout(500);
        await shot('07-edit-in-builder-opened');

        // Config tab (BuilderAutomationPane) is fed the real automationRow
        // for an existing automation -- the cron expr should be visible
        // somewhere in the Config pane, unlike the blank "New automation"
        // draft from flow 6.
        //
        // PRODUCT BUG (not a selector issue), confirmed by reading source +
        // observing this exact failure live: AutomationEditorRoute.tsx's
        // onOpenBuilder (both the create-mode AND this edit-mode call site)
        // does `navigate({automationId: ref, kind:'automation-builder', ...})`
        // where `ref` is the COMPOUND automation ref (refIdRef.current, e.g.
        // "trip-albums/trip-albums"). `BuilderRoute.tsx` feeds that straight
        // into `initialAppId` -> `useBuilder.ts`'s `appId.current`, which
        // `refreshAutomationRow` compares against the BARE `row.ownerApp`
        // (never matches, since one side has a "/" and the other doesn't)
        // and which `ensureConversation`/`streamTurn` URL-encode as a SINGLE
        // path segment (`/_centraid-conversations/apps/<appId>/sessions`,
        // `/centraid/<appId>/_turn`) -- the literal "/" survives
        // `encodeURIComponent` as "%2F", so the gateway 500s resolving an
        // app literally named "<id>/<id>". Result: the builder that opens is
        // an ORPHANED "Untitled"/"Draft" session, NOT the existing
        // automation -- BuilderAutomationPane's Config tab is stuck on
        // "Loading automation…" forever (automationRow.current never
        // resolves). The deleted OLD call sites this replaces correctly
        // used the BARE `row.id` (confirm via `git diff HEAD~1 --
        // apps/desktop/src/renderer/react/shell/routes/HomeRoute.tsx`:
        // `navigate({kind:'automation-builder', automationId: row.id})`).
        // AutomationViewRoute.tsx's NEW composer `onSendMessage` handler has
        // the identical `automationId: row.ref` shape (untested by this
        // suite, but same code pattern -- see that file's line ~148) and is
        // likely affected the same way. Suspected fix locations (NOT
        // applied -- source edits are out of scope for this e2e task):
        // AutomationEditorRoute.tsx's two `automation-builder` navigate
        // calls, AutomationViewRoute.tsx's one.
        const stuckLoading = await page.getByText('Loading automation…', { exact: true }).count();
        console.log(
          `[auto01] BUG CHECK: Config tab stuck on "Loading automation…": ${stuckLoading > 0}`,
        );
        const builderBodyTxt = await bodyText();
        console.log(
          `[auto01] builder body after Open-builder-chat (first 400 chars): ${builderBodyTxt.slice(0, 400).replace(/\n/g, ' | ')}`,
        );
        const hasCron = /0 6 \* \* \*/.test(builderBodyTxt) || /Trip albums/.test(builderBodyTxt);
        console.log(
          `[auto01] builder shows existing automation identity (cron expr or name): ${hasCron}`,
        );
        assert(
          hasCron,
          "expected the builder opened via the editor's Open-builder-chat to show the existing automation's name or cron expr somewhere (Config tab)",
        );
      },
    );

    // ---------------------------------------------------------------------
    // FLOW 8: delete-with-cancel-then-confirm
    // ---------------------------------------------------------------------
    await step(
      'flow8-delete-cancel-then-confirm',
      'Delete -> Cancel keeps it; Delete -> confirm removes it from overview, Home, and the gateway',
      async () => {
        await openAutomationView(TEMPLATE_NAME);
        // Plain "Delete" label (AutomationThreadScreen.tsx) -- the automation
        // name only appears in the confirm dialog's message, not the button.
        const deleteBtn = page.getByRole('button', { name: 'Delete', exact: true });
        await deleteBtn.waitFor({ state: 'visible', timeout: 5_000 });

        // ---- Cancel path ----
        await deleteBtn.click();
        const dialog = page.getByRole('dialog', { name: 'Delete automation?' });
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('08-delete-confirm-dialog');
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await dialog.waitFor({ state: 'hidden', timeout: 5_000 });
        await page.waitForTimeout(300);
        // Still on the view screen -- automation was not deleted.
        await page
          .getByRole('heading', { name: TEMPLATE_NAME, level: 1 })
          .waitFor({ state: 'visible', timeout: 5_000 });
        let rows = await gwListAutomations();
        assert(
          rows.some((r) => r.name === TEMPLATE_NAME),
          'automation should still exist in the gateway after Cancel',
        );
        await shot('08-after-cancel-still-present');

        // ---- Confirm path ----
        await deleteBtn.click();
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
        await page.waitForTimeout(800);
        // onDelete navigates back to the overview on success.
        await page
          .getByRole('heading', { name: 'Automations', level: 1 })
          .waitFor({ state: 'visible', timeout: 10_000 });
        await shot('08-after-confirm-overview');
        // Scope to the FLEET section specifically (AutomationsOverviewScreen.tsx
        // `div[class*="fleet"]`), not an unscoped role=button query — the
        // revamped overview also has a NEW "Recent activity" feed below the
        // fleet, whose `ActivityRow` buttons carry the (possibly-deleted)
        // automation's name too (a run record survives its automation being
        // deleted), so an unscoped name match on "Trip albums" still finds
        // the 3 activity rows from flow4's fired runs even after deletion.
        const ovGone = await page
          .locator('div[class*="fleet"] button', { hasText: TEMPLATE_NAME })
          .count();
        assert(
          ovGone === 0,
          `expected 0 FLEET rows for "${TEMPLATE_NAME}" after confirmed delete, found ${ovGone}`,
        );

        await navTo(page, 'Home');
        await page
          .getByRole('heading', { name: 'What should we build?' })
          .waitFor({ state: 'visible', timeout: 10_000 });
        const homeGone = await page
          .locator('button[data-kind="automation"]', { hasText: TEMPLATE_NAME })
          .count();
        assert(
          homeGone === 0,
          `expected 0 Home AutoCards for "${TEMPLATE_NAME}" after confirmed delete, found ${homeGone}`,
        );
        await shot('08-after-confirm-home');

        rows = await gwListAutomations();
        assert(
          !rows.some((r) => r.name === TEMPLATE_NAME),
          `expected "${TEMPLATE_NAME}" gone from the gateway, rows: ${JSON.stringify(rows.map((r) => r.name))}`,
        );
      },
    );

    // ---------------------------------------------------------------------
    // FLOW 9: relaunch-persistence
    // ---------------------------------------------------------------------
    await step(
      'flow9-relaunch-persistence',
      'Re-adopt + run once, relaunch (same userDataDir) -> automation and its run history survive',
      async () => {
        await adoptTemplate(TEMPLATE_NAME);
        await openAutomationView(TEMPLATE_NAME);
        await runNowFromViewScreen();
        await page.waitForTimeout(3000);
        await shot('09-before-relaunch-run-view');

        const refBefore = await gwFindRef(TEMPLATE_NAME);
        const { json: runsBeforeJson } = await gwFetch(
          `/centraid/_automations/runs?ref=${encodeURIComponent(refBefore)}&limit=50`,
        );
        const runsBefore = runsBeforeJson?.runs ?? [];
        console.log(`[auto01] runs recorded before relaunch: ${runsBefore.length}`);
        assert(runsBefore.length >= 1, 'expected at least 1 recorded run before relaunch');

        await session.close();
        await new Promise((resolve) => setTimeout(resolve, 500));
        session = await launchApp({ userDataDir: USER_DATA_DIR });
        page = session.page;
        wireConsole(page);
        page.setDefaultTimeout(60_000);
        await page.setViewportSize({ width: 1400, height: 900 });
        await shot('09-relaunch-home');

        await openAutomationsOverview();
        const ovRow = page.getByRole('button', { name: new RegExp(TEMPLATE_NAME) }).first();
        await ovRow.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('09-relaunch-overview');

        await openAutomationView(TEMPLATE_NAME);
        await shot('09-relaunch-view-screen');
        const runRowsAfter = await page.locator('button[data-run-status]').count();
        console.log(`[auto01] run-history rows visible after relaunch: ${runRowsAfter}`);
        assert(
          runRowsAfter >= 1,
          `expected >=1 run-history row after relaunch, got ${runRowsAfter}`,
        );

        const refAfter = await gwFindRef(TEMPLATE_NAME);
        assert(
          refAfter === refBefore,
          `expected the same automation ref to survive relaunch, before=${refBefore} after=${refAfter}`,
        );
        const { json: runsAfterJson } = await gwFetch(
          `/centraid/_automations/runs?ref=${encodeURIComponent(refAfter)}&limit=50`,
        );
        const runsAfter = runsAfterJson?.runs ?? [];
        console.log(`[auto01] runs recorded after relaunch: ${runsAfter.length}`);
        assert(
          runsAfter.length === runsBefore.length,
          `expected run count to survive relaunch unchanged, before=${runsBefore.length} after=${runsAfter.length}`,
        );

        // Open the persisted run and confirm its timeline still renders (not
        // just the row list).
        await page.locator('button[data-run-status]').first().click();
        await page.waitForTimeout(1000);
        await shot('09-relaunch-run-view-still-renders');
        const finalNodes = page.locator('[data-status]');
        await finalNodes.first().waitFor({ state: 'visible', timeout: 10_000 });
        const status = await finalNodes.last().getAttribute('data-status');
        console.log(`[auto01] persisted run's final node data-status after relaunch: ${status}`);
        assert(
          status === 'ok' || status === 'fail',
          `persisted run did not render a resolved timeline after relaunch, data-status=${status}`,
        );
      },
    );

    // ---------------------------------------------------------------------
    // Report
    // ---------------------------------------------------------------------
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ AUTOMATIONS LIFECYCLE VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(32)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${String(r.error).split('\n')[0]}`);
    }
    console.log('=======================================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);
    console.log(`Console warnings: ${consoleMessages.filter((m) => m.type === 'warning').length}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll automations-lifecycle steps PASSED.');
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
