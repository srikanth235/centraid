#!/usr/bin/env node
// Chat features QA (2026-07-12): per-subsystem model configuration in
// Settings -> Models -> Agents, against the REAL Electron+gateway rig.
//   Flow 1: Settings nav reaches Models -> Agents
//   Flow 2: "Chat & agent subsystems" group renders 4 rows for the active agent
//   Flow 3: pick a model for one subsystem, persists across a relaunch
//   Flow 4: reset to "Use default model" clears the override
//
// Run with: node apps/desktop/tests/e2e-live/flows-chat-features-03-settings-subsystem-models.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-chat-03');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
const consoleMessages = [];

function wireConsole(p) {
  p.on('console', (msg) => consoleMessages.push({ text: msg.text(), type: msg.type() }));
  p.on('pageerror', (err) => consoleMessages.push({ text: `[pageerror] ${err}`, type: 'error' }));
}

async function step(id, label, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ id, label, verdict: 'pass', ms: Date.now() - t0 });
    console.log(`[PASS] ${id} ${label} (${Date.now() - t0}ms)`);
  } catch (err) {
    results.push({ id, label, verdict: 'fail', ms: Date.now() - t0, error: err?.stack ?? String(err) });
    console.error(`[FAIL] ${id} ${label}: ${err}`);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-chat03-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  await page.screenshot({ path: path.join(OUT_DIR, `chat03-${name}.png`) });
}

async function openSettingsModelsAgents() {
  // navTo() requires an exact accessible-name match; the sidebar's Settings
  // row has a trailing "live" status pill baked into its accessible name
  // (Sidebar.tsx trailing={<StatusPill>live</StatusPill>}), so match loosely.
  await page.getByRole('button', { name: /^Settings/ }).first().click();
  await page.getByRole('button', { name: 'Agents' }).waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByRole('button', { name: 'Agents' }).click();
  await page.waitForTimeout(400);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const t0 = Date.now();
  let session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  console.log(`[chat03] launched + Home ready in ${Date.now() - t0}ms`);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    await step('reach-settings-agents', 'Navigate Settings -> Models -> Agents', async () => {
      await openSettingsModelsAgents();
      const heading = page.locator('text=/Chat & agent subsystems/');
      await heading.waitFor({ state: 'visible', timeout: 10_000 });
      await shot('00-settings-agents-page');
    });

    let activeTitle = null;
    await step('subsystem-rows-render', 'Group renders 4 subsystem rows for the active agent', async () => {
      const labels = ['Assistant', 'In-app Ask', 'Builder', 'Automations'];
      for (const label of labels) {
        const row = page.locator('text=' + label).first();
        await row.waitFor({ state: 'visible', timeout: 5_000 });
      }
      // Determine active agent title from an aria-label like "Assistant model for Claude Code".
      const select = page.locator('select[aria-label^="Assistant model for "]').first();
      const ariaLabel = await select.getAttribute('aria-label');
      activeTitle = ariaLabel?.replace('Assistant model for ', '') ?? null;
      console.log(`[chat03] active agent detected as: ${activeTitle}`);
      assert(activeTitle, 'could not determine active agent title from the Assistant row aria-label');
      const helper = page.locator('text=/Subsystem choices override the default model/');
      await helper.waitFor({ state: 'visible', timeout: 5_000 });
      await shot('01-four-subsystem-rows');
    });

    let chosenModel = null;
    await step('pick-model-for-subsystem', 'Pick a non-default model for the Builder subsystem', async () => {
      const select = page.locator(`select[aria-label="Builder model for ${activeTitle}"]`);
      await select.waitFor({ state: 'visible', timeout: 5_000 });
      const options = await select.locator('option').allTextContents();
      console.log(`[chat03] Builder model options: ${JSON.stringify(options)}`);
      assert(options.length >= 1, 'Builder model select has no options');
      assert(options[0].toLowerCase().includes('default'), `first option should be the "use default" fallback, got: ${options[0]}`);
      if (options.length > 1) {
        await select.selectOption({ index: 1 });
        chosenModel = await select.inputValue();
        console.log(`[chat03] selected Builder model value: ${chosenModel}`);
      } else {
        console.log('[chat03] only the default option is available (no catalog models enumerated) — recording informational note, skipping the pick/persist assertion');
      }
      await shot('02-builder-model-selected');
    });

    if (chosenModel) {
      await step('relaunch-persists-choice', 'Relaunch the app; the Builder model choice persisted via gateway prefs', async () => {
        await session.close();
        session = await launchApp({ userDataDir: USER_DATA_DIR });
        page = session.page;
        wireConsole(page);
        await openSettingsModelsAgents();
        const select = page.locator(`select[aria-label="Builder model for ${activeTitle}"]`);
        await select.waitFor({ state: 'visible', timeout: 10_000 });
        const val = await select.inputValue();
        console.log(`[chat03] Builder model value after relaunch: ${val} (expected ${chosenModel})`);
        assert(val === chosenModel, `Builder model did not persist across relaunch: expected ${chosenModel}, got ${val}`);
        await shot('03-persisted-after-relaunch');
      });

      await step('reset-to-default', 'Reset Builder subsystem back to "Use default model"', async () => {
        const select = page.locator(`select[aria-label="Builder model for ${activeTitle}"]`);
        await select.selectOption({ index: 0 });
        await page.waitForTimeout(500);
        const val = await select.inputValue();
        assert(val === '', `expected empty value after resetting to default, got "${val}"`);
        await shot('04-reset-to-default');
      });
    } else {
      console.log('[chat03] skipping persistence + reset steps (no non-default model was available to select)');
    }

    // ---- Report ----
    console.log('\n================ SETTINGS SUBSYSTEM MODELS VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(28)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log(`Console errors observed: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);
    console.log('===========================================================================');

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll chat03 steps PASSED.');
    }
  } finally {
    await session.close();
    await fs.rm(USER_DATA_DIR, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
