#!/usr/bin/env node
/**
 * One-off screenshot capture of the per-app "Standing orders" popover
 * landed in this PR. Drives the Electron renderer via Playwright's
 * `_electron` driver (CDP under the hood):
 *
 *   1. Builds + seeds a per-run userData dir
 *   2. Pre-populates the gateway SQLite with sample automations so
 *      the popover has real rows to render
 *   3. Launches the app, clicks the seeded tile, opens the gear,
 *      captures the popover region as PNG
 *
 * Saved to `apps/desktop/scripts/out/standing-orders.png` so the
 * caller can read it back.
 *
 * Not part of CI — pure visual-regression aid. Run with:
 *   bun run scripts/screenshot-standing-orders.mjs
 */
import { _electron } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DESKTOP_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'out');
const OUT_FILE = path.join(OUT_DIR, 'standing-orders.png');

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-shot-'));
  const userData = path.join(workspace, 'userData');
  const appsDir = path.join(workspace, 'apps');
  await fs.mkdir(userData, { recursive: true });
  await fs.mkdir(appsDir, { recursive: true });

  // Settings — gateway URL is bogus but the standing-orders panel only
  // reads from the local SQLite mirror so the popover renders without a
  // live gateway.
  await fs.writeFile(
    path.join(userData, 'centraid-settings.json'),
    JSON.stringify(
      {
        appsDir,
        gatewayUrl: 'http://127.0.0.1:1',
        gatewayToken: crypto.randomBytes(8).toString('hex'),
        remoteTemplatesUrl: '',
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  // Seed three automations into the gateway mirror. The path mirrors
  // localRuntimeGatewayDb() — keep this in sync if the local-runtime
  // moves the file.
  const dbDir = path.join(userData, 'local-runtime');
  await fs.mkdir(dbDir, { recursive: true });
  const dbFile = path.join(dbDir, 'centraid-gateway.sqlite');
  await seedAutomations(dbFile);

  // Seed an app dir + the localStorage userApp entry that the home
  // grid renders from. The renderer reads localStorage in-process; we
  // write it via page.evaluate after the window loads.
  const appId = 'journal';
  await seedAppDir(appsDir, appId);

  const app = await _electron.launch({
    args: [DESKTOP_ROOT, `--user-data-dir=${userData}`],
    env: { ...process.env, NODE_ENV: 'test' },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  // Inject the userApp into localStorage and reload so the home grid
  // picks it up.
  await page.evaluate((id) => {
    localStorage.setItem(
      'centraid.v1.home.userApps',
      JSON.stringify([
        {
          id,
          name: 'Journal',
          desc: 'Daily entries with a weekly recap.',
          iconKey: 'Book',
          color: '#7a5cff',
          colorKey: 'violet',
          centraidAppId: id,
        },
      ]),
    );
  }, appId);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  // Open the tile and then the gear popover. Home grid renders cards
  // as `.cd-app-card` inside `.cd-app-card-wrap[data-app-id]`.
  const tile = page.locator(`.cd-app-card-wrap[data-app-id="${appId}"] .cd-app-card`).first();
  await tile.waitFor({ state: 'visible', timeout: 15000 });
  await tile.click();
  await page.locator('.cd-tb-btn[aria-label="App settings"]').click();
  await page.locator('.cd-app-orders').waitFor({ state: 'visible', timeout: 10000 });
  // Brief pause so the toggle transition + hover hint settle before capture.
  await page.waitForTimeout(400);

  // Tight crop on the popover so the screenshot reads as the
  // component, not the chrome.
  const panel = page.locator('.cd-app-settings-panel');
  await panel.screenshot({ path: OUT_FILE, omitBackground: false });

  await app.close();
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  console.log(`wrote ${OUT_FILE}`); // governance: allow-repo-hygiene dev-only CLI prints output path for the caller
}

function seedAutomations(dbFile) {
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA foreign_keys=ON');
  // Bring the DB to migration v2 the same way the runtime does on first
  // open. Copy-pasted DDL — keep in sync with gateway-db.ts MIGRATIONS.
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_prefs (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (user_id, key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      session_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, idx),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS automations (
      app_id TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      manifest_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (app_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_automations_app ON automations(app_id);
    PRAGMA user_version = 2;
  `);

  const now = Date.now();
  const rows = [
    {
      name: 'weekly-recap',
      prompt:
        'Every Sunday at 8pm, summarize the last 7 days of journal entries into a short reflection.',
      cronExpr: '0 20 * * 0',
      enabled: 1,
      action: 'weekly-recap.js',
    },
    {
      name: 'morning-prompt',
      prompt:
        'Every weekday at 7am, write one open-ended question to prompt today’s entry, based on yesterday’s mood.',
      cronExpr: '0 7 * * 1-5',
      enabled: 1,
      action: 'morning-prompt.js',
    },
    {
      name: 'monthly-archive',
      prompt: 'On the first of every month, archive last month’s entries into a single file.',
      cronExpr: '0 2 1 * *',
      enabled: 0,
      action: 'monthly-archive.js',
    },
  ];

  const stmt = db.prepare(`
    INSERT INTO automations (app_id, name, prompt, cron_expr, enabled, manifest_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    const manifest = {
      prompt: r.prompt,
      trigger: { kind: 'cron', expr: r.cronExpr },
      action: r.action,
      requires: { model: 'anthropic/claude-3-5-sonnet' },
      history: { keep: { count: 100 } },
      generated: { by: 'template', at: '2026-05-19T00:00:00Z' },
    };
    stmt.run(
      'journal',
      r.name,
      r.prompt,
      r.cronExpr,
      r.enabled,
      JSON.stringify(manifest),
      now,
      now,
    );
  }
  db.close();
}

async function seedAppDir(appsDir, id) {
  const dir = path.join(appsDir, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'app.json'),
    JSON.stringify({ name: 'Journal', description: 'Daily entries with a weekly recap.' }, null, 2),
  );
  await fs.writeFile(
    path.join(dir, 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>Journal</title><body style="font-family:system-ui;padding:24px;color:#888">(app preview blocked — gateway unreachable in screenshot mode)</body>',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
