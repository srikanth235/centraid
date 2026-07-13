#!/usr/bin/env node
// governance: allow-repo-hygiene file-size-limit (#394) one live create→compile→run scenario
/**
 * Automations headless-compile-to-run live suite (#394).
 *
 * This intentionally replaces the former builder-chat flow. The shipped v0
 * contract is now editor → headless compile → enabled plan → run, and no
 * user-facing surface may require or expose the automation builder.
 *
 * Run with:
 *   node apps/desktop/tests/e2e-live/flows-automations-06-builder-to-run.mjs
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-automations-06-headless-compile');
const AUTOMATION_NAME = 'Headless compile smoke test';
const GOAL_MARKER = 'headless compile smoke test ok';
const GOAL_PROMPT =
  `When this automation runs, do not call an AI model, ctx.tool, or vault data. ` +
  `Return exactly { summary: "${GOAL_MARKER}" }. Keep it manual-only.`;

let page;
let session;
const results = [];
const consoleMessages = [];

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

async function step(id, label, fn) {
  const startedAt = Date.now();
  try {
    await fn();
    results.push({ id, label, verdict: 'pass', ms: Date.now() - startedAt });
    console.log(`[PASS] ${id} (${Date.now() - startedAt}ms) ${label}`);
  } catch (error) {
    results.push({
      id,
      label,
      verdict: 'fail',
      ms: Date.now() - startedAt,
      error: error?.stack ?? String(error),
    });
    console.error(`[FAIL] ${id}: ${error}`);
    await page
      ?.screenshot({ path: path.join(OUT_DIR, `FAIL-auto06-${id}.png`) })
      .catch(() => undefined);
  }
}

async function shot(name) {
  await page.screenshot({ path: path.join(OUT_DIR, `auto06-${name}.png`) });
}

async function gwFetch(pathAndQuery, opts = {}) {
  return page.evaluate(
    async ({ pathAndQuery, method, body }) => {
      const auth = await window.CentraidApi.getGatewayAuth();
      const headers = { 'content-type': 'application/json' };
      if (auth.token) headers.authorization = `Bearer ${auth.token}`;
      if (auth.vaultId) headers['x-centraid-vault'] = auth.vaultId;
      const response = await fetch(`${auth.baseUrl}${pathAndQuery}`, {
        method: method ?? 'GET',
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      return {
        status: response.status,
        json: await response.json().catch(() => null),
      };
    },
    { pathAndQuery, method: opts.method, body: opts.body },
  );
}

async function findAutomation() {
  const { json } = await gwFetch('/centraid/_automations');
  return (json?.rows ?? []).find((row) => row.name === AUTOMATION_NAME) ?? null;
}

async function automationRuns(ref) {
  const { json } = await gwFetch(
    `/centraid/_automations/runs?ref=${encodeURIComponent(ref)}&limit=20`,
  );
  return json?.runs ?? [];
}

async function readRun(runId) {
  const { json } = await gwFetch(`/centraid/_automations/run?runId=${encodeURIComponent(runId)}`);
  return json?.run ?? null;
}

async function waitForCompile(ref, timeoutMs = 6 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await automationRuns(ref);
    const compile = runs.find((run) => run.triggerKind === 'compile');
    if (compile?.endedAt) return compile;
    await page.waitForTimeout(1500);
  }
  throw new Error(`compile did not finish within ${timeoutMs}ms`);
}

async function waitForFire(ref, priorRunIds, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await automationRuns(ref);
    const fire = runs.find(
      (run) => run.triggerKind !== 'compile' && !priorRunIds.has(run.runId) && run.endedAt,
    );
    if (fire) return fire;
    await page.waitForTimeout(1000);
  }
  throw new Error(`automation fire did not finish within ${timeoutMs}ms`);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  page.setDefaultTimeout(60_000);
  page.on('console', (message) => {
    consoleMessages.push({
      type: message.type(),
      text: message.text(),
      frameUrl: message.location()?.url ?? '',
    });
  });
  page.on('pageerror', (error) => {
    consoleMessages.push({ type: 'error', text: String(error), frameUrl: '' });
  });

  let automationRef = null;
  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    await step(
      'create-and-headless-compile',
      'Create from the editor and compile without builder UI',
      async () => {
        const prefs = await gwFetch('/_centraid-user/prefs', {
          method: 'PUT',
          body: { patch: { 'agent.runner.kind': 'claude-code' } },
        });
        assert(prefs.status === 200, `could not pin live runner: ${JSON.stringify(prefs)}`);

        await navTo(page, 'Automations');
        await page.getByRole('heading', { name: 'Automations', level: 1 }).waitFor();
        await page.getByRole('button', { name: 'New automation' }).first().click();
        const name = page.getByLabel('Name', { exact: true });
        const instructions = page.getByLabel('Instructions', { exact: true });
        await name.waitFor();
        await name.fill(AUTOMATION_NAME);
        await instructions.fill(GOAL_PROMPT);
        await shot('01-editor-ready');
        await page.getByRole('button', { name: 'Create automation', exact: true }).click();

        const deadline = Date.now() + 20_000;
        let row = null;
        while (Date.now() < deadline && !row) {
          row = await findAutomation();
          if (!row) await page.waitForTimeout(500);
        }
        assert(row, 'created automation was not published to the gateway');
        automationRef = row.ref;
        assert(row.enabled === false, 'automation must remain disabled while compile is in flight');

        const bodyDuringCompile = await page.locator('body').textContent();
        assert(
          !/open builder chat|describe a change/i.test(bodyDuringCompile ?? ''),
          'builder UI leaked',
        );
        const compile = await waitForCompile(automationRef);
        assert(compile.ok === true, `compile failed: ${compile.error ?? compile.summary}`);
        assert(compile.summary === 'Plan ready', `unexpected compile summary: ${compile.summary}`);

        const compiledRow = await findAutomation();
        assert(
          compiledRow?.enabled === true,
          'first successful compile did not enable the automation',
        );
        await shot('02-plan-ready');
      },
    );

    await step(
      'single-ledger-spine',
      'Compile and fire share the automation thread ledger',
      async () => {
        assert(automationRef, 'missing automation ref');
        const before = await automationRuns(automationRef);
        const compile = before.find((run) => run.triggerKind === 'compile');
        assert(compile?.ok === true, 'successful compile turn missing from the thread');
        const priorRunIds = new Set(before.map((run) => run.runId));

        const runButton = page.getByRole('button', { name: /Run now|Starting…/ }).first();
        await runButton.waitFor();
        await runButton.click();
        const fire = await waitForFire(automationRef, priorRunIds);
        const detail = await readRun(fire.runId);
        const resultText = `${detail?.summary ?? ''} ${detail?.outputJson ?? ''}`.toLowerCase();
        assert(
          detail?.ok === true,
          `compiled automation failed: ${detail?.error ?? 'unknown error'}`,
        );
        assert(resultText.includes(GOAL_MARKER), `run result did not contain "${GOAL_MARKER}"`);

        const after = await automationRuns(automationRef);
        assert(
          after.some((run) => run.runId === compile.runId),
          'compile turn disappeared after fire',
        );
        assert(
          after.some((run) => run.runId === fire.runId),
          'fire turn missing from shared ledger',
        );
        await shot('03-compiled-run-complete');
      },
    );

    await step('console-sweep', 'No unexpected renderer errors', async () => {
      const errors = consoleMessages.filter((message) => message.type === 'error');
      assert(errors.length === 0, `renderer errors: ${JSON.stringify(errors)}`);
    });

    console.log('\n================ AUTOMATIONS HEADLESS COMPILE VERDICT ================');
    for (const result of results) {
      console.log(`${result.verdict.toUpperCase().padEnd(6)} ${result.id} (${result.ms}ms)`);
      if (result.error) console.log(`       ${String(result.error).split('\n')[0]}`);
    }
    const failures = results.filter((result) => result.verdict === 'fail');
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error('FATAL:', error);
  process.exitCode = 1;
});
