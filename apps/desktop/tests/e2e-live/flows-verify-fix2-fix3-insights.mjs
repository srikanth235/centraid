#!/usr/bin/env node
// Verification for FIX 2 (Insights automation-name labels) and FIX 3 (codex
// chat-turn token/cost telemetry), reusing the userdata-insights-01 profile
// (regenerated via flows-insights-01.mjs — the original fixture from a prior
// session was gone from disk when this run started, likely cleaned up by a
// concurrent agent sharing this worktree; a fresh equivalent was rebuilt:
// 3 "System health check" automation runs + 1 interactive chat turn).
//
// Run with: node apps/desktop/tests/e2e-live/flows-verify-fix2-fix3-insights.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launchApp, navTo } from './driver.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-insights-01');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-fix23-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `fix23-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function bodyText() {
  return page.evaluate(() => document.body.innerText);
}

async function openInsights() {
  await navTo(page, 'Insights');
  await page
    .getByRole('heading', { name: 'Insights', level: 1 })
    .waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(700);
}

async function findJournalDb() {
  const { stdout } = await execFileAsync('find', [USER_DATA_DIR, '-name', 'journal.db']);
  const p = stdout.trim().split('\n')[0];
  assert(p, 'journal.db not found under userdata-insights-01');
  return p;
}

async function sqlite(db, query) {
  const { stdout } = await execFileAsync('sqlite3', ['-header', '-column', db, query]);
  return stdout.trim();
}

async function sendChatMessage(text) {
  const input = page.getByPlaceholder('Ask your vault anything…');
  await input.waitFor({ state: 'visible', timeout: 10_000 });
  await input.fill(text);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);

  const deadline = Date.now() + 180_000;
  let settled = false;
  while (Date.now() < deadline) {
    const busyBtn = await page.getByRole('button', { name: 'Stop' }).count();
    if (busyBtn === 0) {
      settled = true;
      break;
    }
    await page.waitForTimeout(2000);
  }
  return settled;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const t0 = Date.now();
  let session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  console.log(`[fix23] launched + Home ready in ${Date.now() - t0}ms (userData=${USER_DATA_DIR})`);

  const dbPath = await findJournalDb();
  console.log(`[fix23] journal.db: ${dbPath}`);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    // ================= FIX 2: automation-name labels =================
    await step(
      'fix2-labels',
      'Insights "By source"/"Recent activity" show "System health check", not generic labels',
      async () => {
        await openInsights();
        await shot('fix2-insights-full-page');
        const bodyTxt = await bodyText();
        console.log(
          `[fix23] Insights body (first 1000 chars): ${JSON.stringify(bodyTxt.slice(0, 1000))}`,
        );

        // "By source" table row — must show the resolved automation NAME, not
        // the generic "Automation" kind label. (KindBadge "AUTOMATION" chips
        // elsewhere are fine/expected — this checks the SOURCE row label.)
        const bySourceSection = page
          .locator('text=By source')
          .locator('xpath=ancestor::*[self::section or contains(@class,"panel")][1]');
        const bySourceText = await bySourceSection
          .first()
          .textContent()
          .catch(() => bodyTxt);
        console.log(`[fix23] By source panel text: ${JSON.stringify(bySourceText?.slice(0, 400))}`);
        assert(
          /System health check/.test(bySourceText ?? ''),
          'By source panel missing "System health check" label',
        );

        // Chat row should still say "Chat" (unaffected, expected).
        assert(/\bChat\b/.test(bodyTxt), 'expected a "Chat" source row to remain');

        // Recent activity rows for automation runs — must show the automation
        // name, not the raw handler summary "ok".
        const recentSection = page
          .locator('text=Recent activity')
          .locator('xpath=ancestor::*[self::section or contains(@class,"panel")][1]');
        const recentText = await recentSection
          .first()
          .textContent()
          .catch(() => bodyTxt);
        console.log(
          `[fix23] Recent activity panel text: ${JSON.stringify(recentText?.slice(0, 600))}`,
        );
        assert(
          /System health check/.test(recentText ?? ''),
          'Recent activity missing "System health check" label for automation runs',
        );
        // The old bug rendered the literal raw handler summary "ok" as a
        // standalone recent-activity row label — check no such literal token.
        const rawOkRow = /(^|\n)\s*ok\s*(\n|$)/.test(recentText ?? '');
        console.log(`[fix23] Recent activity contains a standalone "ok" row: ${rawOkRow}`);
        assert(
          !rawOkRow,
          'Recent activity still shows raw handler summary "ok" instead of the automation name',
        );
      },
    );

    // ================= FIX 3a: baseline KPIs =================
    let baselineTokensText = '';
    let baselineSpentText = '';
    await step(
      'fix3a-baseline-kpis',
      'Note baseline Tokens/Spent KPIs before sending a new chat message',
      async () => {
        await openInsights();
        const tokensBlock = await page
          .locator('text=Tokens · 30 days')
          .locator('xpath=..')
          .textContent();
        const spentBlock = await page.locator('text=Spent · USD').locator('xpath=..').textContent();
        baselineTokensText = tokensBlock ?? '';
        baselineSpentText = spentBlock ?? '';
        console.log(`[fix23] BASELINE Tokens KPI: ${JSON.stringify(baselineTokensText)}`);
        console.log(`[fix23] BASELINE Spent KPI: ${JSON.stringify(baselineSpentText)}`);
        await shot('fix3a-baseline-kpis');
      },
    );

    // ================= FIX 3b: send a chat message =================
    await step(
      'fix3b-send-chat',
      'Assistant: send "say hi", wait up to 180s for a real codex reply',
      async () => {
        await navTo(page, 'Assistant');
        await shot('fix3b-assistant-before-send');
        const t = Date.now();
        const settled = await sendChatMessage('say hi');
        console.log(`[fix23] first chat turn settled=${settled} in ${Date.now() - t}ms`);
        await shot('fix3b-assistant-after-reply');
        assert(settled, 'chat turn did not settle within 180s');
      },
    );

    // ================= FIX 3c: Insights after the turn =================
    await step(
      'fix3c-insights-after-turn',
      'Insights KPIs nonzero, By model shows gpt-*, new Chat row in Recent activity',
      async () => {
        await navTo(page, 'Home');
        await page.waitForTimeout(300);
        await openInsights();
        await shot('fix3c-insights-after-llm-turn');
        const bodyTxt = await bodyText();
        console.log(
          `[fix23] Insights body after chat turn (first 1200 chars): ${JSON.stringify(bodyTxt.slice(0, 1200))}`,
        );

        const tokensBlock = await page
          .locator('text=Tokens · 30 days')
          .locator('xpath=..')
          .textContent();
        const spentBlock = await page.locator('text=Spent · USD').locator('xpath=..').textContent();
        console.log(`[fix23] AFTER Tokens KPI: ${JSON.stringify(tokensBlock)}`);
        console.log(`[fix23] AFTER Spent KPI: ${JSON.stringify(spentBlock)}`);

        const tokenMatch = (tokensBlock ?? '').match(/Tokens · 30 days\s*([\d,]+)/);
        const totalTokens = tokenMatch ? Number(tokenMatch[1].replace(/,/g, '')) : NaN;
        console.log(`[fix23] parsed totalTokens KPI = ${totalTokens}`);
        assert(
          Number.isFinite(totalTokens) && totalTokens > 0,
          `expected nonzero totalTokens KPI, got ${JSON.stringify(tokensBlock)}`,
        );

        const noSpentZero = !/Spent · USD\s*\$0\.00/.test(spentBlock ?? '');
        console.log(`[fix23] Spent KPI is > $0.00: ${noSpentZero}`);
        assert(noSpentZero, `expected Spent KPI > $0.00, got ${JSON.stringify(spentBlock)}`);

        const noModelYet = await page.locator('text=No model usage recorded yet.').count();
        console.log(`[fix23] "No model usage recorded yet." present: ${noModelYet > 0}`);
        assert(noModelYet === 0, 'By model panel still shows empty state after a real chat turn');
        assert(/gpt-/i.test(bodyTxt), 'expected a gpt-* model row in By model panel');

        const noActivityYet = await page.locator('text=No activity yet.').count();
        assert(noActivityYet === 0, 'Recent activity panel still empty after a real chat turn');
      },
    );

    // ================= FIX 3d: DB ground truth (1st turn) =================
    let turn1 = null;
    await step(
      'fix3d-db-ground-truth',
      'DB: newest interactive turn has nonzero tokens + non-NULL cost; newest step item has model set',
      async () => {
        const turnsOut = await sqlite(
          dbPath,
          "SELECT id, started_at, total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cost_usd FROM turns WHERE trigger='interactive' ORDER BY started_at DESC LIMIT 3;",
        );
        console.log(`[fix23] turns (interactive, newest first):\n${turnsOut}`);

        const itemsOut = await sqlite(
          dbPath,
          "SELECT model, input_tokens, output_tokens, cache_read_tokens, cost_usd FROM items WHERE kind='step' ORDER BY started_at DESC LIMIT 1;",
        );
        console.log(`[fix23] newest step item:\n${itemsOut}`);

        const rows = turnsOut.split('\n').slice(2); // skip header + separator
        const first = rows[0]?.trim().split(/\s{2,}/);
        console.log(`[fix23] parsed newest turn row: ${JSON.stringify(first)}`);
        assert(first && first.length >= 6, `could not parse newest turn row: ${turnsOut}`);
        const [id, startedAt, inTok, outTok, cacheTok, cost] = first;
        turn1 = {
          id,
          startedAt: Number(startedAt),
          inTok: Number(inTok),
          outTok: Number(outTok),
          cacheTok: Number(cacheTok),
          cost,
        };
        assert(
          turn1.inTok + turn1.outTok + turn1.cacheTok > 0,
          `newest interactive turn has all-zero token columns: ${turnsOut}`,
        );
        assert(
          cost && cost !== '' && cost.toLowerCase() !== 'null',
          `newest interactive turn has NULL/empty cost: ${turnsOut}`,
        );

        const itemRows = itemsOut.split('\n').slice(2);
        const itemFirst = itemRows[0]?.trim().split(/\s{2,}/);
        console.log(`[fix23] parsed newest step item: ${JSON.stringify(itemFirst)}`);
        assert(
          itemFirst && itemFirst[0] && itemFirst[0].toLowerCase() !== 'null' && itemFirst[0] !== '',
          `newest step item missing model: ${itemsOut}`,
        );
      },
    );

    // ================= FIX 3e: second turn, own usage not cumulative =================
    await step(
      'fix3e-second-turn-not-cumulative',
      'Second chat message (thread resume) records its OWN turn usage, not cumulative doubling',
      async () => {
        await navTo(page, 'Assistant');
        await page.waitForTimeout(500);
        await shot('fix3e-assistant-before-second-send');
        const t = Date.now();
        const settled = await sendChatMessage('thanks, one more: what is 2+2?');
        console.log(`[fix23] second chat turn settled=${settled} in ${Date.now() - t}ms`);
        await shot('fix3e-assistant-after-second-reply');
        assert(settled, 'second chat turn did not settle within 180s');

        const turnsOut = await sqlite(
          dbPath,
          "SELECT id, started_at, total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cost_usd FROM turns WHERE trigger='interactive' ORDER BY started_at DESC LIMIT 3;",
        );
        console.log(`[fix23] turns after 2nd message (interactive, newest first):\n${turnsOut}`);

        const rows = turnsOut.split('\n').slice(2);
        const second = rows[0]?.trim().split(/\s{2,}/);
        const first = rows[1]?.trim().split(/\s{2,}/);
        assert(second && first, `expected 2 interactive turns in DB, got:\n${turnsOut}`);
        const t2 = {
          id: second[0],
          inTok: Number(second[2]),
          outTok: Number(second[3]),
          cacheTok: Number(second[4]),
          cost: second[5],
        };
        const t1 = {
          id: first[0],
          inTok: Number(first[2]),
          outTok: Number(first[3]),
          cacheTok: Number(first[4]),
          cost: first[5],
        };
        console.log(`[fix23] SIDE BY SIDE — turn1: ${JSON.stringify(t1)}`);
        console.log(`[fix23] SIDE BY SIDE — turn2: ${JSON.stringify(t2)}`);
        assert(t2.id !== t1.id, 'second turn has the same id as the first — no new turn recorded');
        const t1Total = t1.inTok + t1.outTok + t1.cacheTok;
        const t2Total = t2.inTok + t2.outTok + t2.cacheTok;
        assert(t2Total > 0, `second turn has all-zero tokens: ${JSON.stringify(t2)}`);
        const ratio = t2Total / t1Total;
        console.log(
          `[fix23] turn2/turn1 total-token ratio = ${ratio.toFixed(2)} (expect roughly ~1x, NOT ~2x cumulative doubling)`,
        );
        assert(
          ratio < 1.6,
          `second turn's tokens look cumulative (ratio ${ratio.toFixed(2)}x vs first turn) — thread-resume diffing may be broken`,
        );
      },
    );

    // ---------- Report ----------
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ FIX 2 + FIX 3 (INSIGHTS/CODEX) VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(32)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${String(r.error).split('\n')[0]}`);
    }
    console.log('================================================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll FIX 2 + FIX 3 steps PASSED.');
    }
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
