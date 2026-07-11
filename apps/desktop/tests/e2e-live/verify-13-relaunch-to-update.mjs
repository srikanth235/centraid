#!/usr/bin/env node
// Relaunch-to-update pill — REAL app, real dist watcher, no mocks.
//   node apps/desktop/tests/e2e-live/verify-13-relaunch-to-update.mjs
// (prereq: `bun run build` inside apps/desktop)
//
// Path: launch → no pill → touch a watched dist file (a "new build" landing
// while the app runs) → watcher (10s poll, needs a settled repeat) shows the
// sidebar pill within ~30s → screenshot → click → the running instance exits
// and a relaunched instance appears (same argv) → kill the relaunched one.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DESKTOP_ROOT, launchApp } from './driver.mjs';

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/** PIDs of app instances keyed to this run's unique userData dir. */
async function pidsFor(userDataDir) {
  const { stdout } = await exec('pgrep', ['-f', userDataDir]).catch(() => ({ stdout: '' }));
  return stdout.split('\n').filter(Boolean).map(Number);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const { app, page, userDataDir, close } = await launchApp();
  console.log(`[relaunch] launched (userData=${userDataDir})`);
  let clicked = false;

  try {
    const pill = page.getByRole('button', { name: /Relaunch to update/ });

    // No update yet — the pill must not render on a fresh launch.
    assert((await pill.count()) === 0, 'pill rendered before any new build landed');
    console.log('[relaunch] no pill on fresh launch — OK');

    // A "new build" lands: touching a watched output changes its mtime,
    // exactly what any real rebuild does.
    await fs.utimes(
      path.join(DESKTOP_ROOT, 'dist', 'renderer', 'styles.css'),
      new Date(),
      new Date(),
    );
    console.log('[relaunch] touched dist/renderer/styles.css — waiting for the watcher');

    // 10s poll + settle-confirmation tick ⇒ worst case ~30s.
    await pill.waitFor({ state: 'visible', timeout: 45_000 });
    const label = await pill.textContent();
    console.log(`[relaunch] pill visible: "${label}"`);
    assert(label?.includes('v0.1.0'), `pill should carry the on-disk version, got "${label}"`);
    await page.screenshot({ path: path.join(OUT_DIR, 'relaunch-pill.png') });

    // Click → the running instance exits (relaunch spawns a successor).
    const closedEvent = new Promise((resolve) => app.on('close', resolve));
    await pill.click();
    clicked = true;
    await closedEvent;
    console.log('[relaunch] running instance exited after click — OK');

    // The successor process must exist (same argv ⇒ same userData marker).
    let successors = [];
    for (let i = 0; i < 20 && successors.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      successors = await pidsFor(userDataDir);
    }
    assert(successors.length > 0, 'no relaunched instance appeared');
    console.log(`[relaunch] relaunched instance up (pid ${successors.join(', ')}) — killing it`);
    await exec('kill', successors.map(String));
    console.log('[relaunch] PASS');
  } finally {
    // Normal close only if we never clicked (the click already tore it down).
    if (!clicked) await close().catch(() => {});
    else await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('[relaunch] FAIL:', err);
  process.exit(1);
});
