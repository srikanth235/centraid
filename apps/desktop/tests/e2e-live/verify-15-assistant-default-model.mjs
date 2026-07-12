#!/usr/bin/env node
// governance: allow-repo-hygiene file-size-limit — single coherent live-app
// verification scenario for one fix, splitting mid-scenario would fragment
// one story across files with no readability gain.
//
// Verifies, against the REAL Electron app, the fix for: the Assistant chat
// screen never passed `model` to its turn API, so every Assistant turn used
// the Claude Agent SDK's own internal default instead of the model picked in
// Settings -> Agents -> "Default model for Claude Code"
// (apps/desktop/src/renderer/react/shell/routes/AssistantRoute.tsx).
//
// Flow: activate Claude Code + pick "haiku" via the real UI, send a trivial
// real Assistant turn, then confirm Insights -> "By model" panel shows
// "haiku" (not opus) for that turn.
//
// Run with: node apps/desktop/tests/e2e-live/verify-15-assistant-default-model.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-verify-15-model');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
const consoleMessages = [];

function wireConsole(p) {
  p.on('console', (msg) => {
    consoleMessages.push({ text: msg.text(), type: msg.type() });
  });
  p.on('pageerror', (err) => {
    consoleMessages.push({ text: `[pageerror] ${err}`, type: 'error' });
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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-v15-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `v15-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function bodyText() {
  return page.evaluate(() => document.body.textContent);
}

async function openSettingsAgents() {
  await page.getByRole('button', { name: /^Settings/ }).first().click();
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.waitForTimeout(600);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  await page.setViewportSize({ width: 1400, height: 900 });

  try {
    // ---------- 1. Settings -> Agents: activate Claude Code + pick haiku ----------
    await step(
      '01-activate-claude-haiku',
      'Settings -> Agents: activate Claude Code tab + select Haiku model via UI',
      async () => {
        await openSettingsAgents();
        const deadline1 = Date.now() + 20_000;
        while (Date.now() < deadline1) {
          const txt = await bodyText();
          if (/Claude Code/.test(txt) && !/Reading credential status/.test(txt)) break;
          await page.waitForTimeout(500);
        }
        await shot('01-settings-agents-before');

        const tab = page.getByRole('tab', { name: 'Claude Code' });
        await tab.waitFor({ state: 'visible', timeout: 10_000 });
        const alreadyActive = (await tab.getAttribute('aria-selected')) === 'true';
        if (!alreadyActive) {
          await tab.click();
          await page.waitForTimeout(800);
        }

        const select = page.getByRole('combobox', { name: 'Default model for Claude Code' });
        await select.waitFor({ state: 'visible', timeout: 10_000 });
        const deadline2 = Date.now() + 20_000;
        let haikuAvailable = false;
        while (Date.now() < deadline2) {
          const optionValues = await select
            .locator('option')
            .evaluateAll((opts) => opts.map((o) => o.value));
          if (optionValues.includes('haiku')) {
            haikuAvailable = true;
            break;
          }
          await page.waitForTimeout(500);
        }
        assert(haikuAvailable, '"haiku" option never appeared in the Claude Code model select');
        await select.selectOption({ value: 'haiku' });
        await page.waitForTimeout(400);
        const selectedValue = await select.inputValue();
        console.log(`[v15] model select value after pick: ${selectedValue}`);
        assert(selectedValue === 'haiku', `expected select value "haiku", got "${selectedValue}"`);
        await shot('01-agent-activated-haiku');
      },
    );

    // ---------- 2. Real LLM turn through Assistant ----------
    let llmSettled = false;
    await step(
      '02-real-llm-turn',
      'Assistant: send "reply with: ok", wait up to 180s for completion',
      async () => {
        await navTo(page, 'Assistant');
        await page
          .getByPlaceholder('Ask your vault anything…')
          .waitFor({ state: 'visible', timeout: 10_000 });
        await shot('02-before-send');
        const input = page.getByPlaceholder('Ask your vault anything…');
        await input.fill('reply with: ok');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1000);
        await shot('02-sending');

        const deadline = Date.now() + 180_000;
        while (Date.now() < deadline) {
          const busyBtn = await page.getByRole('button', { name: 'Stop' }).count();
          if (busyBtn === 0) {
            llmSettled = true;
            break;
          }
          await page.waitForTimeout(2000);
        }
        await shot('02-after-turn');
        const txt = await bodyText();
        const sawError = /503|unavailable|no runner|could not reach|failed to/i.test(txt);
        console.log(`[v15] llmSettled=${llmSettled} sawErrorHint=${sawError}`);
        if (sawError) {
          console.log(`[v15] body text snapshot: ${txt.slice(0, 1500).replace(/\n/g, ' | ')}`);
        }
        assert(llmSettled, 'LLM turn did not settle within 180s');
      },
    );

    // ---------- 3. Insights "By model" shows haiku, not opus ----------
    await step(
      '03-insights-by-model-is-haiku',
      'Insights -> By model panel reflects haiku (the fix), not the SDK default opus',
      async () => {
        await navTo(page, 'Insights');
        await page
          .getByRole('heading', { name: 'Insights', level: 1 })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForTimeout(1000);
        await shot('03-insights-populated');
        const txt = await bodyText();

        const noModelYet = await page.locator('text=No model usage recorded yet.').count();
        console.log(`[v15] "No model usage recorded yet." present: ${noModelYet > 0}`);
        assert(noModelYet === 0, 'By model panel still empty after real turn');

        const byModelMatch = txt.match(/By model[\s\S]{0,300}/);
        const byModelText = byModelMatch?.[0] ?? '';
        console.log(`[v15] By-model panel text: ${JSON.stringify(byModelText)}`);

        // Screenshot the By-model panel specifically as evidence.
        const byModelHeading = page.getByText('By model', { exact: false }).first();
        await byModelHeading.scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);
        await shot('03-by-model-panel');

        const sawHaiku = /haiku/i.test(byModelText);
        const sawOpus = /opus/i.test(byModelText);
        console.log(`[v15] By-model mentions haiku=${sawHaiku} opus=${sawOpus}`);
        assert(
          sawHaiku,
          `expected "haiku" in the By-model panel after picking Haiku in Settings, got: ${byModelText}`,
        );
        assert(
          !sawOpus,
          `By-model panel still shows an opus model — the picked "haiku" default was not honored: ${byModelText}`,
        );
      },
    );

    // ---------- Report ----------
    console.log('\n================ VERIFY-15 VERDICT TABLE ================');
    for (const r of results) {
      console.log(
        `${r.verdict.toUpperCase().padEnd(13)} ${r.id.padEnd(32)} ${r.label} (${r.ms}ms)`,
      );
      if (r.error) console.log(`       -> ${String(r.error).split('\n')[0]}`);
    }
    console.log('===========================================================');
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll verify-15 steps PASSED.');
    }
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
