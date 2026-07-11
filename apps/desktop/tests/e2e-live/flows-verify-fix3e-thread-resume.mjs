#!/usr/bin/env node
// Focused re-check of FIX 3's thread-resume path: two messages sent in the
// SAME conversation (same codex thread), staying on the Assistant page the
// whole time (no nav away/back between sends — that was found to open a
// fresh conversation rather than resuming the prior one). Verifies the
// second turn's DB usage is its own per-turn delta, not the thread's
// cumulative total (which would show up as ~2x the first turn).
//
// Run with: node apps/desktop/tests/e2e-live/flows-verify-fix3e-thread-resume.mjs
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

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const t0 = Date.now();
  const session = await launchApp({ userDataDir: USER_DATA_DIR });
  const page = session.page;
  const consoleMessages = [];
  page.on('console', (msg) => consoleMessages.push({ text: msg.text(), type: msg.type() }));
  page.on('pageerror', (err) =>
    consoleMessages.push({ text: `[pageerror] ${err}`, type: 'error' }),
  );
  console.log(`[fix3e] launched + Home ready in ${Date.now() - t0}ms`);

  const dbPath = await findJournalDb();
  console.log(`[fix3e] journal.db: ${dbPath}`);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await navTo(page, 'Assistant');
    await page.getByRole('button', { name: '+ New conversation' }).click();
    await page.waitForTimeout(300);

    const input = page.getByPlaceholder('Ask your vault anything…');
    await input.waitFor({ state: 'visible', timeout: 10_000 });

    const uniqueTag = `resume-test-${Date.now()}`;
    const send = async function send(text) {
      await input.fill(text);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1000);
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const busy = await page.getByRole('button', { name: 'Stop' }).count();
        if (busy === 0) return true;
        await page.waitForTimeout(2000);
      }
      return false;
    };

    console.log(`[fix3e] sending turn A: "say hi (${uniqueTag})"`);
    const okA = await send(`say hi (${uniqueTag})`);
    console.log(`[fix3e] turn A settled=${okA}`);
    assert(okA, 'turn A did not settle within 180s');
    await page.screenshot({ path: path.join(OUT_DIR, 'fix3e-resume-turnA.png') });

    const turnsAfterA = await sqlite(
      dbPath,
      "SELECT id, started_at, total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cost_usd FROM turns WHERE trigger='interactive' ORDER BY started_at DESC LIMIT 1;",
    );
    console.log(`[fix3e] DB newest interactive turn after A:\n${turnsAfterA}`);

    // Crucially: stay on the SAME page/conversation — no navTo, no clicking
    // another conversation entry — just send the next message straight into
    // the same open thread (thread-resume path).
    console.log(`[fix3e] sending turn B in the SAME conversation: "what is 2+2? (${uniqueTag})"`);
    const okB = await send(`what is 2+2? (${uniqueTag})`);
    console.log(`[fix3e] turn B settled=${okB}`);
    assert(okB, 'turn B did not settle within 180s');
    await page.screenshot({ path: path.join(OUT_DIR, 'fix3e-resume-turnB.png') });

    // Confirm both messages landed in ONE conversation (sidebar shows a
    // single thread, not two) — proves this was a true thread-resume, not
    // an accidental new conversation per send.
    const threadTitles = await page.locator('button:has-text("' + uniqueTag + '")').count();
    console.log(
      `[fix3e] sidebar entries containing our unique tag: ${threadTitles} (expect 1 — same thread reused for both sends)`,
    );

    const turnsAfterB = await sqlite(
      dbPath,
      "SELECT id, started_at, total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cost_usd FROM turns WHERE trigger='interactive' ORDER BY started_at DESC LIMIT 2;",
    );
    console.log(`[fix3e] DB newest 2 interactive turns after B (newest first):\n${turnsAfterB}`);

    const rows = turnsAfterB.split('\n').slice(2);
    const b = rows[0]?.trim().split(/\s{2,}/);
    const a = rows[1]?.trim().split(/\s{2,}/);
    assert(a && b, `expected 2 interactive turns, got:\n${turnsAfterB}`);
    const turnA = {
      id: a[0],
      inTok: Number(a[2]),
      outTok: Number(a[3]),
      cacheTok: Number(a[4]),
      cost: a[5],
    };
    const turnB = {
      id: b[0],
      inTok: Number(b[2]),
      outTok: Number(b[3]),
      cacheTok: Number(b[4]),
      cost: b[5],
    };
    console.log(`[fix3e] SIDE BY SIDE (same thread) — turnA: ${JSON.stringify(turnA)}`);
    console.log(`[fix3e] SIDE BY SIDE (same thread) — turnB: ${JSON.stringify(turnB)}`);

    assert(
      turnA.id !== turnB.id,
      'turn B has the same id as turn A — no new turn recorded for the 2nd send',
    );
    const totalA = turnA.inTok + turnA.outTok + turnA.cacheTok;
    const totalB = turnB.inTok + turnB.outTok + turnB.cacheTok;
    assert(totalB > 0, `turn B has all-zero tokens: ${JSON.stringify(turnB)}`);
    const ratio = totalB / totalA;
    console.log(
      `[fix3e] turnB/turnA total-token ratio = ${ratio.toFixed(2)} (thread-resume case; expect roughly ~1x-ish, NOT ~2x cumulative doubling)`,
    );

    // Also fetch the newest step item to confirm model resolved correctly
    // for the resumed-thread turn.
    const itemOut = await sqlite(
      dbPath,
      "SELECT model, input_tokens, output_tokens, cache_read_tokens, cost_usd FROM items WHERE kind='step' ORDER BY started_at DESC LIMIT 1;",
    );
    console.log(`[fix3e] newest step item (turn B):\n${itemOut}`);

    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log(`[fix3e] console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);

    if (ratio >= 1.6) {
      console.error(
        `[fix3e] FAIL — turn B looks cumulative (ratio ${ratio.toFixed(2)}x) — thread-resume diffing may be broken`,
      );
      process.exitCode = 1;
    } else if (threadTitles !== 1) {
      console.error(
        `[fix3e] FAIL — expected exactly 1 conversation with our unique tag, found ${threadTitles} (test methodology issue, not necessarily a product bug — needs manual check)`,
      );
      process.exitCode = 1;
    } else {
      console.log(
        '[fix3e] PASS — thread-resume path records per-turn usage correctly, not cumulative.',
      );
    }
  } catch (err) {
    await page
      .screenshot({ path: path.join(OUT_DIR, 'fix3e-resume-FAILURE.png') })
      .catch(() => undefined);
    console.error('[fix3e] FATAL:', err);
    process.exitCode = 1;
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
