#!/usr/bin/env node
/**
 * One-off visual capture of the redesigned Automations surfaces, driven
 * through the real Electron renderer via Playwright's `_electron` driver
 * against an in-process MOCK gateway that returns seeded automations + runs.
 *
 * Captures: overview (health strip + identity rows), detail (trigger hero),
 * run viewer (Direction-A timeline + KPI rail), templates gallery. Dark is
 * primary; also grabs the overview in light to prove token theming.
 *
 * Not part of CI — a visual aid. Run with:
 *   bun run apps/desktop/scripts/screenshot-automations.mjs
 */
import { _electron } from 'playwright';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DESKTOP_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'out');

const now = Date.now();
const MIN = 60_000;

const manifest = (over) => ({
  name: over.name,
  version: '1.0.0',
  description: over.desc ?? '',
  enabled: over.enabled,
  prompt: over.prompt,
  triggers: over.triggers,
  requires: { model: 'capability:balanced', mcps: over.mcps ?? [], tools: [] },
  apps: over.apps ?? [],
  onFailure: over.onFailure,
  history: { keep: { count: 50 } },
  generated: { by: 'template', at: '2026-05-19T00:00:00Z' },
});

const AUTOS = [
  {
    id: 'daily-digest',
    ref: 'daily-digest/daily-digest',
    ownerApp: 'daily-digest',
    name: 'Daily standup digest',
    enabled: true,
    triggers: [{ kind: 'cron', expr: '0 9 * * 1-5' }],
    prompt:
      'Every weekday at 9am, gather yesterday’s merged PRs and open issues, then post a concise standup digest to Slack.',
    desc: 'Posts a weekday standup digest to Slack.',
    mcps: ['Slack', 'GitHub'],
  },
  {
    id: 'pr-watcher',
    ref: 'pr-watcher/pr-watcher',
    ownerApp: 'pr-watcher',
    name: 'PR review watcher',
    enabled: false,
    triggers: [{ kind: 'webhook', id: 'whk_3a9f2c' }],
    prompt:
      'When a pull request is opened, summarize the diff and flag risky changes for the on-call reviewer.',
    desc: 'Summarizes incoming PRs on a webhook.',
    mcps: ['GitHub', 'Linear'],
  },
  {
    id: 'monthly-archive',
    ref: 'monthly-archive/monthly-archive',
    ownerApp: 'monthly-archive',
    name: 'Monthly metrics archive',
    enabled: false,
    triggers: [{ kind: 'cron', expr: '0 2 1 * *' }],
    prompt: 'On the first of each month, snapshot the metrics dashboard into a dated report.',
    desc: 'Archives last month’s metrics.',
    mcps: ['Datadog'],
  },
];

const rowFor = (a) => ({
  id: a.id,
  dir: `/tmp/${a.id}`,
  name: a.name,
  triggers: a.triggers,
  enabled: a.enabled,
  ownerApp: a.ownerApp,
  ref: a.ref,
  manifest: manifest(a),
});

const ROWS = AUTOS.map(rowFor);

// Runs feed — daily-digest has several (one failed → "need attention"),
// pr-watcher has one success; monthly-archive has none (→ draft).
const RUNS = [
  {
    runId: 'run_001',
    kind: 'automation',
    automationId: 'daily-digest/daily-digest',
    triggerKind: 'scheduled',
    triggerOrigin: 'cron',
    startedAt: now - 40 * MIN,
    endedAt: now - 40 * MIN + 4200,
    ok: true,
    summary: 'Posted digest: 6 PRs merged, 3 issues opened.',
    pinned: false,
    totalInputTokens: 4200,
    totalOutputTokens: 880,
    totalCostUsd: 0.021,
    stepCount: 4,
  },
  {
    runId: 'run_002',
    kind: 'automation',
    automationId: 'daily-digest/daily-digest',
    triggerKind: 'scheduled',
    triggerOrigin: 'cron',
    startedAt: now - 24 * 60 * MIN,
    endedAt: now - 24 * 60 * MIN + 3100,
    ok: false,
    error: 'Slack API returned 429 (rate limited) after 2 retries.',
    pinned: false,
    totalInputTokens: 3900,
    totalOutputTokens: 120,
    totalCostUsd: 0.014,
    stepCount: 3,
  },
  {
    runId: 'run_003',
    kind: 'automation',
    automationId: 'pr-watcher/pr-watcher',
    triggerKind: 'interactive',
    triggerOrigin: 'webhook',
    startedAt: now - 3 * 60 * MIN,
    endedAt: now - 3 * 60 * MIN + 5400,
    ok: true,
    summary: 'Reviewed PR #482 — flagged 1 risky migration.',
    pinned: false,
    totalInputTokens: 6100,
    totalOutputTokens: 1500,
    totalCostUsd: 0.039,
    stepCount: 5,
  },
];

const NODES = {
  run_001: [
    {
      nodeId: 'run_001:1',
      runId: 'run_001',
      ordinal: 1,
      kind: 'tool',
      name: 'github.list_merged_prs',
      ok: true,
      startedAt: now,
      endedAt: now + 700,
      durationMs: 700,
      argsJson: JSON.stringify({ repo: 'acme/web', since: '24h' }),
      outputJson: JSON.stringify({ count: 6, prs: [481, 480, 478, 475, 472, 470] }),
    },
    {
      nodeId: 'run_001:2',
      runId: 'run_001',
      ordinal: 2,
      kind: 'agent',
      name: 'summarize',
      model: 'capability:balanced',
      ok: true,
      startedAt: now + 700,
      endedAt: now + 3500,
      durationMs: 2800,
      inputTokens: 4200,
      outputTokens: 880,
      outputJson: JSON.stringify({
        text: '6 PRs merged overnight — auth refactor (#481) and the rate-limiter fix (#478) are the headliners. 3 new issues opened, none blocking.',
      }),
    },
    {
      nodeId: 'run_001:3',
      runId: 'run_001',
      ordinal: 3,
      kind: 'tool',
      name: 'slack.post_message',
      ok: true,
      startedAt: now + 3500,
      endedAt: now + 4200,
      durationMs: 700,
      argsJson: JSON.stringify({ channel: '#standup', blocks: 4 }),
      outputJson: JSON.stringify({ ok: true, ts: '1717... ' }),
    },
  ],
  run_003: [
    {
      nodeId: 'run_003:1',
      runId: 'run_003',
      ordinal: 1,
      kind: 'tool',
      name: 'github.get_pull_request',
      ok: true,
      startedAt: now,
      endedAt: now + 800,
      durationMs: 800,
      argsJson: JSON.stringify({ owner: 'acme', repo: 'web', number: 482 }),
      outputJson: JSON.stringify({ title: 'Migrate sessions table', files: 7, additions: 240 }),
    },
    {
      nodeId: 'run_003:2',
      runId: 'run_003',
      ordinal: 2,
      kind: 'agent',
      name: 'review',
      model: 'capability:balanced',
      ok: true,
      startedAt: now + 800,
      endedAt: now + 4200,
      durationMs: 3400,
      inputTokens: 6100,
      outputTokens: 1500,
      outputJson: JSON.stringify({
        text: 'The migration drops the legacy `token` column without a backfill — risky. Recommend a two-step deploy.',
      }),
    },
    {
      nodeId: 'run_003:3',
      runId: 'run_003',
      ordinal: 3,
      kind: 'tool',
      name: 'linear.create_comment',
      ok: true,
      startedAt: now + 4200,
      endedAt: now + 4700,
      durationMs: 500,
      argsJson: JSON.stringify({ issue: 'ENG-1182', body: 'Flagged risky migration in PR #482.' }),
      outputJson: JSON.stringify({ ok: true }),
    },
  ],
};

const TEMPLATES = [
  {
    id: 'tmpl-standup',
    name: 'Standup digest',
    desc: 'Summarize merged PRs + open issues into a daily Slack post.',
    colorKey: 'indigo',
    iconKey: 'Bolt',
    version: '1.0.0',
    kind: 'automation',
    emoji: '📋',
    category: 'Team rituals',
    triggerKind: 'cron',
    triggerLabel: 'Weekdays · 9:00am',
    integrations: ['Slack', 'GitHub'],
  },
  {
    id: 'tmpl-pr',
    name: 'PR review watcher',
    desc: 'Summarize diffs and flag risky changes when a PR opens.',
    colorKey: 'violet',
    iconKey: 'Bolt',
    version: '1.0.0',
    kind: 'automation',
    emoji: '🔍',
    category: 'Engineering',
    triggerKind: 'webhook',
    triggerLabel: 'On webhook',
    integrations: ['GitHub', 'Linear'],
  },
  {
    id: 'tmpl-oncall',
    name: 'Incident triage',
    desc: 'Triage PagerDuty alerts and draft an initial status update.',
    colorKey: 'rose',
    iconKey: 'Bolt',
    version: '1.0.0',
    kind: 'automation',
    emoji: '🚨',
    category: 'Engineering',
    triggerKind: 'webhook',
    triggerLabel: 'On webhook',
    integrations: ['PagerDuty', 'Slack'],
  },
];

// The renderer is a file:// (null-origin) page, so Playwright `fulfill`
// responses get CORS-masked to status 0. Instead we run a real local server
// that sets `access-control-allow-origin: *` (mirroring the in-process
// gateway) and rewrite just the automation/template requests to it via
// `route.continue({ url })`. Boot-time calls keep hitting the real gateway.
function json(res, body, status = 200) {
  res.statusCode = status;
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function startSeedServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = url.pathname;
    if (p.endsWith('/centraid/_automations')) return json(res, { rows: ROWS });
    if (p.endsWith('/_automations/read')) {
      const ref = url.searchParams.get('ref');
      return json(res, { row: ROWS.find((r) => r.ref === ref) ?? null });
    }
    if (p.endsWith('/_automations/runs')) {
      const ref = url.searchParams.get('ref');
      return json(res, { runs: ref ? RUNS.filter((r) => r.automationId === ref) : RUNS });
    }
    if (p.endsWith('/_automations/run/nodes')) {
      return json(res, { nodes: NODES[url.searchParams.get('runId')] ?? [] });
    }
    // SSE — return a non-event 404 so the renderer falls back to a one-shot
    // ledger read (settled run).
    if (p.endsWith('/_automations/run/events')) return json(res, { error: 'no stream' }, 404);
    if (p.endsWith('/_automations/run')) {
      return json(res, {
        run: RUNS.find((r) => r.runId === url.searchParams.get('runId')) ?? null,
      });
    }
    if (p.endsWith('/_templates')) return json(res, TEMPLATES);
    return json(res, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function routeGateway(page, base) {
  const redirect = (route) => {
    const u = new URL(route.request().url());
    route.continue({ url: base + u.pathname + u.search });
  };
  await page.route('**/centraid/_automations**', redirect);
  await page.route('**/centraid/_templates**', redirect);
}

async function shot(page, name) {
  await page.waitForTimeout(450);
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`wrote ${file}`); // governance: allow-repo-hygiene dev-only CLI prints output path
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const seed = await startSeedServer();
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-aushot-'));
  const userData = path.join(workspace, 'userData');
  const appsDir = path.join(workspace, 'apps');
  await fs.mkdir(userData, { recursive: true });
  await fs.mkdir(appsDir, { recursive: true });
  await fs.writeFile(
    path.join(userData, 'centraid-settings.json'),
    JSON.stringify(
      {
        appsDir,
        gatewayUrl: 'http://127.0.0.1:1',
        gatewayToken: crypto.randomBytes(8).toString('hex'),
        remoteTemplatesUrl: '',
        onboardingCompletedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  const app = await _electron.launch({
    args: [DESKTOP_ROOT, `--user-data-dir=${userData}`],
    env: { ...process.env, NODE_ENV: 'test' },
  });
  const page = await app.firstWindow();
  await routeGateway(page, seed.base);
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1280, height: 860 });

  // Sidebar → Automations.
  const navItem = page.locator('.cd-sb-item', { hasText: 'Automations' }).first();
  await navItem.waitFor({ state: 'visible', timeout: 20000 });
  await navItem.click();
  await page.locator('.cd-au-health').waitFor({ state: 'visible', timeout: 15000 });
  await shot(page, 'overview-dark');

  // Light theme overview (token check).
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await shot(page, 'overview-light');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));

  // Detail (trigger hero) — open the first automation.
  await page.locator('.cd-au-ov-row').first().click();
  await page.locator('.cd-au-hero').waitFor({ state: 'visible', timeout: 15000 });
  await shot(page, 'detail-dark');

  // Run viewer — open a run from the detail's run history. Expand the agent
  // node so the capture shows a node card's response body.
  await page.locator('.cd-au-run').first().click();
  await page.locator('.cd-au-tl').waitFor({ state: 'visible', timeout: 15000 });
  await page
    .locator('.cd-au-tl-head')
    .nth(1)
    .click()
    .catch(() => undefined);
  await shot(page, 'runviewer-dark');

  // Direction B — flip to the single-column Log via the header toggle.
  await page.locator('.cd-au-rv-seg-b').nth(1).click();
  await page.locator('.cd-au-log').waitFor({ state: 'visible', timeout: 10000 });
  await shot(page, 'runviewer-log');
  // Flip back to Timeline so the persisted pref doesn't leak into later runs.
  await page
    .locator('.cd-au-rv-seg-b')
    .nth(0)
    .click()
    .catch(() => undefined);

  // Templates gallery — back to Automations, then Browse templates.
  await page.locator('.cd-sb-item', { hasText: 'Automations' }).first().click();
  await page.locator('.cd-au-health').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('.cd-au-btn-ghost', { hasText: 'Browse templates' }).first().click();
  await page.locator('.cd-au-tpl-toolbar').waitFor({ state: 'visible', timeout: 15000 });
  await shot(page, 'templates-dark');

  // Preview drawer.
  await page.locator('.cd-au-tpl-card').first().click();
  await page.locator('.cd-au-drawer').waitFor({ state: 'visible', timeout: 10000 });
  await shot(page, 'templates-drawer');

  // Builder Direction B — open an automation in the builder, switch to the
  // Flow tab. Best-effort: the builder boot makes extra gateway calls the
  // mock only stubs, so don't fail the run if it can't settle.
  try {
    await page.keyboard.press('Escape');
    await page.locator('.cd-sb-item', { hasText: 'Automations' }).first().click();
    await page.locator('.cd-au-ov-row').first().click();
    await page.locator('.cd-au-hero').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('.cd-au-btn-icon').first().click();
    await page
      .locator('.ab-config, .ab-flow')
      .first()
      .waitFor({ state: 'visible', timeout: 15000 });
    await page.getByRole('button', { name: 'Flow' }).first().click();
    await page.locator('.ab-flow-node').first().waitFor({ state: 'visible', timeout: 10000 });
    await shot(page, 'builder-flow');
  } catch {
    console.log('builder-flow capture skipped (builder did not settle in mock harness)'); // governance: allow-repo-hygiene dev-only CLI status line
  }

  await app.close();
  await seed.close();
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
