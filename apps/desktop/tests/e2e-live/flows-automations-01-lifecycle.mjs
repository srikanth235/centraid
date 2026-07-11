#!/usr/bin/env node
// Automations lifecycle QA suite: adopt-from-template, view screen, run-now +
// timeline, run history (3 runs, open an older one), enable/disable, "New
// automation" from scratch, edit-in-builder, delete (cancel then confirm),
// relaunch persistence.
//
// SELECTOR NOTE: the brief that seeded this suite named `.cd-au-*` classes
// (`.cd-au-ov-*`, `.cd-au-view`, `.cd-au-switch`, `.cd-au-btn-primary`, etc).
// Those don't exist in the current renderer -- AutomationsOverviewScreen.tsx /
// AutomationViewScreen.tsx / RunViewScreen.tsx all use Vite CSS Modules
// (generateScopedName: '[name]__[local]__[hash:base64:5]', see
// apps/desktop/vite.config.ts:36-38), so a class like `.run` compiles to
// something like `AutomationViewScreen__run__a1B2c` at runtime -- there is no
// stable literal `cd-au-*` string anywhere. This suite instead uses, in order
// of preference: (1) real ARIA roles/names (heading, dialog, switch, tab),
// (2) literal `title`/`aria-label`/`data-*` attributes that the source hard-
// codes verbatim (confirmed by reading AutomationViewScreen.tsx,
// RunViewScreen.tsx, AutomationsOverviewScreen.tsx, confirm.ts), and (3) the
// repo's own `[class*="substring"]` CSS-module convention (already used in
// flows-full.mjs, flows-shell-03-*.mjs, flows-verify-fix1-starred.mjs) only
// where no semantic attribute exists.
//
// Run with: node apps/desktop/tests/e2e-live/flows-automations-01-lifecycle.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-automations-01');

const TEMPLATE_NAME = 'System health check';

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
  return page.evaluate(() => document.body.innerText);
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
  // Adopting an automation template navigates straight to its builder
  // (confirmed in flows-insights-01.mjs and by TemplatesRoute.tsx:25,34).
  await page.getByRole('button', { name: 'Config' }).waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(500);
  await shot('adopt-after-use-template-builder');
}

async function runNowFromViewScreen() {
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
      'Discover -> Automations tab -> adopt "System health check" -> on Home AND Automations overview',
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
      'Automation view screen: hero (name, cron trigger since template has no webhook), enable switch, Run now',
      async () => {
        await openAutomationView(TEMPLATE_NAME);
        await shot('02-view-screen');

        const bodyTxt = await bodyText();
        // packages/blueprints/automations/system-health-check/automations/system-health-check/automation.json
        // declares a single `cron` trigger ("30 17 * * *"), no webhook -- so
        // the hero should render the cron/next-runs block, not a webhook URL.
        // NOTE: document.body.innerText reflects CSS text-transform (the
        // heroNextLbl/eyebrow labels render visually as "NEXT 3 RUNS" via
        // `text-transform: uppercase`), so match case-insensitively.
        assert(
          /30 17 \* \* \*/.test(bodyTxt),
          `expected cron expr "30 17 * * *" in hero, got body head: ${bodyTxt.slice(0, 300)}`,
        );
        assert(
          /next 3 runs/i.test(bodyTxt),
          'expected "Next 3 runs" hero block for a cron-triggered automation',
        );
        assert(
          !/Provisioning endpoint/.test(bodyTxt),
          'unexpected webhook-provisioning UI for a cron-only automation',
        );

        // The native checkbox is the standard visually-hidden-input pattern
        // (AutomationViewScreen.module.css `.switch input { opacity: 0;
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

        const editBtn = page.locator('button[title="Edit in builder"]');
        await editBtn.waitFor({ state: 'visible', timeout: 5_000 });
        const deleteBtn = page.getByRole('button', {
          name: `Delete ${TEMPLATE_NAME}`,
          exact: true,
        });
        await deleteBtn.waitFor({ state: 'visible', timeout: 5_000 });
      },
    );

    // ---------------------------------------------------------------------
    // FLOW 3: run-now-and-timeline
    // ---------------------------------------------------------------------
    await step(
      'flow3-run-now-and-timeline',
      'Run now -> run viewer timeline renders a resolved final node; expand a node (or Log mode if no tool nodes)',
      async () => {
        await runNowFromViewScreen();
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

        const runRows = page.locator('button[data-ok]');
        const runRowCount = await runRows.count();
        console.log(`[auto01] run-history rows visible on automation view: ${runRowCount}`);
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
        // Oldest run = last in a newest-first feed.
        olderRunId = runs[runs.length - 1]?.runId ?? null;
        assert(Boolean(olderRunId), 'could not determine an older runId to open from history');

        // Open the OLDEST run row (last row rendered, since RunRow feed is
        // newest-first) from the UI, not by URL — exercises the actual click path.
        await runRows.last().click();
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
    await step(
      'flow6-create-new-automation',
      '"New automation" from overview -> builder opens, accepts a prompt, shows progress',
      async () => {
        await openAutomationsOverview();
        const newBtn = page.getByRole('button', { name: 'New automation' });
        await newBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await newBtn.click();

        // scaffoldAutomationDraft() mints a REAL gateway row named "New
        // automation" (createAutomation({ id, name: 'New automation',
        // enabled: false })) before the builder even paints, then navigates
        // to { kind: 'automation-builder', automationId: id }.
        await page
          .getByRole('button', { name: 'Config' })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForTimeout(500);
        await shot('06-new-automation-builder-opened');

        const rowsAfterScaffold = await gwListAutomations();
        const draftRow = rowsAfterScaffold.find((r) => r.name === 'New automation');
        console.log(
          `[auto01] scaffolded draft row present in gateway: ${Boolean(draftRow)} ref=${draftRow?.ref}`,
        );
        assert(
          Boolean(draftRow),
          'expected "New automation" to exist as a real gateway row immediately after clicking New automation',
        );

        const textarea = page.getByPlaceholder('Describe a change…');
        await textarea.waitFor({ state: 'visible', timeout: 10_000 });
        await textarea.fill("Every weekday morning, summarize yesterday's new GitHub issues.");
        await page.getByRole('button', { name: 'Send' }).click();
        await page.waitForTimeout(1500);
        await shot('06-new-automation-after-send');

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
      '"Edit in builder" on the adopted automation -> builder opens seeded with its existing config',
      async () => {
        await openAutomationView(TEMPLATE_NAME);
        const editBtn = page.locator('button[title="Edit in builder"]');
        await editBtn.waitFor({ state: 'visible', timeout: 5_000 });
        await editBtn.click();

        await page
          .getByRole('button', { name: 'Config' })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForTimeout(500);
        await shot('07-edit-in-builder-opened');

        // Config tab (BuilderAutomationPane) is fed the real automationRow
        // for an existing automation -- the cron expr should be visible
        // somewhere in the Config pane, unlike the blank "New automation"
        // draft from flow 6.
        const bodyTxt = await bodyText();
        console.log(
          `[auto01] builder body after Edit-in-builder (first 400 chars): ${bodyTxt.slice(0, 400).replace(/\n/g, ' | ')}`,
        );
        const hasCron = /30 17 \* \* \*/.test(bodyTxt) || /System health check/.test(bodyTxt);
        console.log(
          `[auto01] builder shows existing automation identity (cron expr or name): ${hasCron}`,
        );
        assert(
          hasCron,
          "expected the builder opened via Edit-in-builder to show the existing automation's name or cron expr somewhere (Config tab)",
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
        const deleteBtn = page.getByRole('button', {
          name: `Delete ${TEMPLATE_NAME}`,
          exact: true,
        });
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
        const ovGone = await page.getByRole('button', { name: new RegExp(TEMPLATE_NAME) }).count();
        assert(
          ovGone === 0,
          `expected 0 overview rows for "${TEMPLATE_NAME}" after confirmed delete, found ${ovGone}`,
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
        await new Promise((r) => setTimeout(r, 500));
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
        const runRowsAfter = await page.locator('button[data-ok]').count();
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
        await page.locator('button[data-ok]').first().click();
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
