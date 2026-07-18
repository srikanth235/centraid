// governance: allow-repo-hygiene file-size-limit — one cohesive e2e harness (mock
// gateway + record builders + DOM helpers) shared by every spec; splitting it would
// scatter the single source of fixture truth. See receipts/issue-225-desktop-e2e-suite.md.
import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/*
 * E2E harness for the desktop app, rebuilt for the post-#109/#137/#141
 * architecture:
 *
 *   - App *code* lives in the gateway's git store; the renderer is a thin
 *     HTTP client that talks to the ACTIVE gateway directly (Bearer token).
 *   - `settings.json` no longer carries a gateway URL/token — those are
 *     derived from the active gateway profile under
 *     `<userData>/gateways/<id>/`. So to point the app at our mock we seed a
 *     *remote* gateway profile whose `url` is the mock, set it active, and
 *     mark onboarding complete.
 *   - Apps/automations/runs/templates all come from the gateway over HTTP,
 *     so the mock is the single source of fixture data — `gateway.state` is
 *     mutable and every test shapes it before (or during) the run.
 *
 * Each test owns a fresh tmp `userData`, a fresh mock gateway on a random
 * loopback port, and its own Electron process — state never leaks.
 */

// ─────────────────────────── mock gateway ───────────────────────────

export interface AppMetaEntry {
  id: string;
  name?: string;
  description?: string;
  kind?: 'app' | 'automation';
  hasIndex: boolean;
}

/** Raw git-store version row (what GET /git-versions returns). */
export interface GitVersion {
  tag: string;
  version: number;
  sha: string;
  uploadedAt: string;
  active: boolean;
}

/** A single SSE frame: the JSON object to emit, plus an optional pre-delay (ms). */
export interface SseFrame {
  data: Record<string, unknown>;
  delayMs?: number;
}

export interface MockState {
  /** GET /centraid/_apps */
  apps: AppMetaEntry[];
  /** GET /centraid/_templates */
  templates: Array<Record<string, unknown>>;
  /** GET /centraid/_automations → { rows } */
  automations: Array<Record<string, unknown>>;
  /** GET /centraid/_automations/runs → { runs } (also per-ref) */
  runs: Array<Record<string, unknown>>;
  /** GET /centraid/_automations/run?runId= → { run } */
  runsById: Record<string, Record<string, unknown>>;
  /** GET /centraid/_automations/run/nodes?runId= → { nodes } */
  nodesByRun: Record<string, Array<Record<string, unknown>>>;
  /** GET /centraid/_apps/:id/git-versions (undefined → 404 = never published) */
  versions: Record<string, GitVersion[]>;
  /** GET /centraid/_apps/:id/logs → { entries } */
  logsById: Record<string, Array<Record<string, unknown>>>;
  /** GET /centraid/_apps/:id/files → { files } */
  filesById: Record<string, Array<{ path: string; content: string }>>;
  /** GET /_centraid-user/prefs → { prefs } */
  prefs: Record<string, unknown>;
  /** GET /centraid/_insights/summary */
  insights: Record<string, unknown>;
  /** GET /centraid/_turn/runner-status */
  runnerStatus: Record<string, unknown>;
  /** GET /centraid/_agents/status */
  agentsStatus: Record<string, unknown>;
  /** GET /_centraid-conversations/apps/:appId/sessions → { sessions } */
  conversations: Array<Record<string, unknown>>;
  /** GET /_centraid-conversations/apps/:appId/sessions/:id → messages */
  conversationMessages: Array<Record<string, unknown>>;

  /** Whether GET /centraid/_draft/.../ returns 200 (available) or 404. */
  draftAvailable: boolean;

  /** Per-method status overrides keyed by a coarse op name. */
  automationsStatus: number; // GET /centraid/_automations (drives the list error card)
  deleteStatus: number; // DELETE /centraid/_apps/:id
  publishStatus: number; // POST /centraid/_apps/:id/publish
  runNowStatus: number; // POST /centraid/_automations/run-now
  setEnabledStatus: number; // POST /centraid/_automations/set-enabled
  /** When set, EVERY route returns this status (e.g. 401 to drive auth_required). */
  forceStatus?: number;

  /** runId minted by run-now + reported on create. */
  nextRunId: string;
  /** Result body for clone. */
  cloneResult?: Record<string, unknown>;
  /** Result body for create-app. */
  createAppResult?: Record<string, unknown>;
  /** Result body for create-automation. */
  createAutomationResult?: Record<string, unknown>;

  /** SSE frames for POST /centraid/:appId/_turn */
  turnFrames: SseFrame[];
  /** SSE frames for GET /centraid/_automations/run/events */
  runFrames: SseFrame[];
}

export interface MockGateway {
  url: string;
  token: string;
  state: MockState;
  /** Calls observed, in arrival order (excludes OPTIONS preflight). */
  calls: Array<{ method: string; pathname: string; search: string; auth?: string; body?: string }>;
  /** Convenience: number of calls matching a method + path predicate. */
  countCalls(method: string, pathTest: (p: string) => boolean): number;
  close(): Promise<void>;
}

interface MockGatewayOptions {
  /** Optional on-disk git-store mirror used by persistence e2e assertions. */
  appsDir?: string;
}

function defaultState(): MockState {
  return {
    apps: [],
    templates: [],
    automations: [],
    runs: [],
    runsById: {},
    nodesByRun: {},
    versions: {},
    logsById: {},
    filesById: {},
    prefs: {},
    insights: {},
    runnerStatus: { ok: true, kind: 'local', version: 'test', models: ['tier-fast', 'tier-deep'] },
    agentsStatus: { agents: [], models: [] },
    conversations: [],
    conversationMessages: [],
    draftAvailable: true,
    automationsStatus: 200,
    deleteStatus: 200,
    publishStatus: 200,
    runNowStatus: 200,
    setEnabledStatus: 200,
    nextRunId: 'run-1',
    turnFrames: [],
    runFrames: [],
  };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization,content-type',
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
}

async function writeSse(res: http.ServerResponse, frames: SseFrame[]): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...CORS,
  });
  for (const f of frames) {
    if (f.delayMs) await new Promise((resolve) => setTimeout(resolve, f.delayMs));
    res.write(`data: ${JSON.stringify(f.data)}\n\n`);
  }
  res.write('event: end\ndata: {}\n\n');
  res.end();
}

export async function startMockGateway(options: MockGatewayOptions = {}): Promise<MockGateway> {
  const state = defaultState();
  if (options.appsDir) {
    const persisted = await readMockApps(options.appsDir);
    state.apps = persisted.apps;
    state.automations = persisted.automations;
  }
  const calls: MockGateway['calls'] = [];
  const token = crypto.randomBytes(16).toString('hex');

  const server = http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = url.pathname;

    if (method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({
        method,
        pathname: p,
        search: url.search,
        auth: req.headers['authorization'] as string | undefined,
        body: body || undefined,
      });

      if (state.forceStatus && state.forceStatus !== 200) {
        json(res, state.forceStatus, { error: 'forced' });
        return;
      }

      void route(method, p, url, body, res, state, options).catch((err: unknown) => {
        json(res, 500, { error: String(err) });
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('mock gateway: no address');

  return {
    url: `http://127.0.0.1:${addr.port}`,
    token,
    state,
    calls,
    countCalls(m, t) {
      return calls.filter((c) => c.method === m && t(c.pathname)).length;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

async function route(
  method: string,
  p: string,
  url: URL,
  body: string,
  res: http.ServerResponse,
  s: MockState,
  options: MockGatewayOptions,
): Promise<void> {
  const seg = p.split('/').filter(Boolean); // e.g. ['centraid','_apps','todo-abc']

  // ---- editing/session lifecycle (match specific before /:id) ----
  if (p === '/centraid/_apps/_sessions' && method === 'POST') {
    const sid = (() => {
      try {
        return (JSON.parse(body) as { sessionId?: string }).sessionId;
      } catch {
        return undefined;
      }
    })();
    return json(res, 200, { sessionId: sid ?? 'desktop-x' });
  }
  if (p.startsWith('/centraid/_apps/_sessions/') && method === 'DELETE') {
    return json(res, 200, { ok: true });
  }
  if (p === '/centraid/_apps/_clone' && method === 'POST') {
    const result = s.cloneResult ?? defaultCloneResult(body);
    const app = result.app as Partial<AppMetaEntry> | undefined;
    if (app?.id) {
      if (app.kind === 'automation') {
        s.automations = [
          ...s.automations.filter((entry) => entry.id !== app.id),
          automationRow({ id: app.id, name: app.name }),
        ];
      } else {
        s.apps = [
          ...s.apps.filter((entry) => entry.id !== app.id),
          appEntry({ ...app, id: app.id, hasIndex: app.hasIndex ?? true }),
        ];
      }
      if (options.appsDir) await writeMockApp(options.appsDir, app.id, app);
    }
    return json(res, 200, result);
  }

  // ---- draft preview probe ----
  if (p.startsWith('/centraid/_draft/')) {
    if (s.draftAvailable) {
      res.writeHead(200, { 'content-type': 'text/html', ...CORS });
      res.end('<!doctype html><title>draft</title><body>draft preview</body>');
    } else {
      res.writeHead(404, CORS);
      res.end('not found');
    }
    return;
  }

  // ---- apps collection ----
  if (p === '/centraid/_apps') {
    if (method === 'GET') return json(res, 200, s.apps);
    if (method === 'POST') {
      const parsed = safeJson(body);
      const id = (parsed.id as string) ?? 'new-app';
      const result = s.createAppResult ?? {
        app: { id, name: parsed.name, kind: 'app', hasIndex: true },
      };
      const app = result.app as Partial<AppMetaEntry> | undefined;
      if (app?.id) {
        s.apps = [
          ...s.apps.filter((entry) => entry.id !== app.id),
          appEntry({ ...app, id: app.id, hasIndex: app.hasIndex ?? true }),
        ];
        if (options.appsDir) await writeMockApp(options.appsDir, app.id, app);
      }
      return json(res, 200, result);
    }
  }

  // ---- single app: /centraid/_apps/:id[/...] ----
  if (seg[0] === 'centraid' && seg[1] === '_apps' && seg[2]) {
    const id = decodeURIComponent(seg[2]);
    const sub = seg[3];
    if (!sub) {
      if (method === 'DELETE') {
        // Mirror the gateway: a 200 or 404 (already-gone) drops the app from
        // the registry, so a subsequent listApps() won't resurrect the tile.
        // A 5xx leaves it registered. (Offline is modelled by closing the
        // server entirely, so this handler never runs in that case.)
        if (s.deleteStatus === 200 || s.deleteStatus === 404) {
          s.apps = s.apps.filter((a) => a.id !== id);
          if (options.appsDir) {
            await fs.rm(path.join(options.appsDir, id), { recursive: true, force: true });
          }
        }
        if (s.deleteStatus === 200) return json(res, 200, { id });
        return json(res, s.deleteStatus, { error: s.deleteStatus === 404 ? 'not_found' : 'error' });
      }
    }
    if (sub === 'logs' && method === 'GET')
      return json(res, 200, { entries: s.logsById[id] ?? [] });
    if (sub === 'files') {
      if (method === 'GET') return json(res, 200, { files: s.filesById[id] ?? [] });
      if (method === 'PUT')
        return json(res, 200, { path: decodeURIComponent(seg[4] ?? ''), size: body.length });
    }
    if (sub === 'meta' && method === 'POST') return json(res, 200, { ok: true });
    if (sub === 'publish' && method === 'POST') {
      if (s.publishStatus !== 200) return json(res, s.publishStatus, { error: 'publish_failed' });
      return json(res, 200, { id, versionTag: 'v1', sha: 'abc123' });
    }
    if (sub === 'reset-data' && method === 'POST')
      return json(res, 200, { id, seeded: true, migrationsApplied: [] });
    if (sub === 'git-versions' && method === 'GET') {
      const v = s.versions[id];
      if (!v) return json(res, 404, { error: 'no_tags' });
      return json(res, 200, { versions: v });
    }
    if (sub === 'rollback' && method === 'POST') return json(res, 200, { id, sha: 'rollback-sha' });
  }

  // ---- templates ----
  if (p === '/centraid/_templates' && method === 'GET') return json(res, 200, s.templates);

  // ---- user identity + prefs ----
  if (p === '/_centraid-user/id' && method === 'GET') return json(res, 200, { id: 'user-test' });
  if (p === '/_centraid-user/prefs') {
    if (method === 'GET') return json(res, 200, { prefs: s.prefs });
    if (method === 'PUT') {
      const patch = (safeJson(body).patch as Record<string, unknown>) ?? {};
      s.prefs = { ...s.prefs, ...patch };
      return json(res, 200, { prefs: s.prefs });
    }
  }

  // ---- automations ----
  if (p === '/centraid/_automations') {
    if (method === 'GET') {
      if (s.automationsStatus !== 200)
        return json(res, s.automationsStatus, { error: 'list_failed' });
      return json(res, 200, { rows: s.automations });
    }
    if (method === 'POST')
      return json(res, 200, s.createAutomationResult ?? { row: defaultAutomationRow(body) });
    if (method === 'DELETE') return json(res, 200, { deletedApp: true });
  }
  if (p === '/centraid/_automations/read' && method === 'GET') {
    const ref = url.searchParams.get('ref') ?? '';
    const row = s.automations.find((a) => a.ref === ref) ?? null;
    return json(res, 200, { row });
  }
  if (p === '/centraid/_automations/run-now' && method === 'POST') {
    if (s.runNowStatus !== 200) return json(res, s.runNowStatus, { error: 'run_failed' });
    return json(res, 200, { runId: s.nextRunId });
  }
  if (p === '/centraid/_automations/runs' && method === 'GET') {
    const ref = url.searchParams.get('ref');
    const runs = ref ? s.runs.filter((r) => r.automationId === ref) : s.runs;
    return json(res, 200, { runs });
  }
  if (p === '/centraid/_automations/run' && method === 'GET') {
    const runId = url.searchParams.get('runId') ?? '';
    return json(res, 200, { run: s.runsById[runId] ?? null });
  }
  if (p === '/centraid/_automations/run/nodes' && method === 'GET') {
    const runId = url.searchParams.get('runId') ?? '';
    return json(res, 200, { nodes: s.nodesByRun[runId] ?? [] });
  }
  if (p === '/centraid/_automations/run/events' && method === 'GET') {
    void writeSse(res, s.runFrames);
    return;
  }
  if (p === '/centraid/_automations/run/pin' && method === 'POST')
    return json(res, 200, { ok: true });
  if (p === '/centraid/_automations/set-enabled' && method === 'POST') {
    if (s.setEnabledStatus !== 200) return json(res, s.setEnabledStatus, { error: 'failed' });
    return json(res, 200, { ok: true });
  }

  // ---- insights ----
  if (p === '/centraid/_insights/summary' && method === 'GET') return json(res, 200, s.insights);

  // ---- runner / agents ----
  if (p === '/centraid/_turn/runner-status' && method === 'GET')
    return json(res, 200, s.runnerStatus);
  if (p === '/centraid/_agents/status' && method === 'GET') return json(res, 200, s.agentsStatus);

  // ---- vault consent context used by the current automation fleet/thread ----
  if (p === '/centraid/_vault/agents' && method === 'GET') return json(res, 200, { agents: [] });
  if (p === '/centraid/_vault/blocking' && method === 'GET')
    return json(res, 200, { outbox: [], needsAuth: [], parked: [], scopeRequests: [] });
  if (p === '/centraid/_vault/outbox-grants' && method === 'GET')
    return json(res, 200, { grants: [] });

  // ---- unified chat turn (SSE) ----
  if (seg[0] === 'centraid' && seg[2] === '_turn' && method === 'POST') {
    void writeSse(res, s.turnFrames);
    return;
  }

  // ---- conversations ----
  if (seg[0] === '_centraid-conversations' && seg[1] === 'apps' && seg[3] === 'sessions') {
    const sid = seg[4];
    if (!sid) {
      if (method === 'GET') return json(res, 200, { sessions: s.conversations });
      if (method === 'POST') {
        const title = (safeJson(body).title as string) ?? '';
        const now = Date.now();
        const conv = {
          id: `conv-${s.conversations.length + 1}`,
          title,
          createdAt: now,
          updatedAt: now,
          pinned: false,
          archived: false,
        };
        s.conversations.unshift(conv);
        return json(res, 200, conv);
      }
    } else {
      if (method === 'GET')
        return json(res, 200, {
          id: sid,
          title: '',
          createdAt: 0,
          messages: s.conversationMessages,
        });
      if (method === 'PATCH' || method === 'DELETE') return json(res, 200, { ok: true });
    }
  }
  if (seg[0] === '_centraid-conversations' && seg[3] === 'blobs' && method === 'POST') {
    return json(res, 200, { hash: 'blob-hash', sizeBytes: body.length });
  }

  // Absorb ambient/unknown calls so the renderer never blows up.
  json(res, 200, {});
}

async function writeMockApp(
  appsDir: string,
  id: string,
  app: Partial<AppMetaEntry>,
): Promise<void> {
  const directory = path.join(appsDir, id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, 'app.json'),
    `${JSON.stringify({ id, name: app.name ?? id, kind: app.kind ?? 'app' }, null, 2)}\n`,
  );
}

async function readMockApps(
  appsDir: string,
): Promise<{ apps: AppMetaEntry[]; automations: Array<Record<string, unknown>> }> {
  const entries = await fs.readdir(appsDir, { withFileTypes: true }).catch(() => []);
  const apps: AppMetaEntry[] = [];
  const automations: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(
        await fs.readFile(path.join(appsDir, entry.name, 'app.json'), 'utf8'),
      ) as Partial<AppMetaEntry>;
      const id = manifest.id ?? entry.name;
      if (manifest.kind === 'automation') {
        automations.push(automationRow({ id, name: manifest.name }));
      } else {
        apps.push(appEntry({ ...manifest, id, hasIndex: manifest.hasIndex ?? true }));
      }
    } catch {
      // A half-written directory is intentionally absent from the mock's
      // restart inventory, matching the gateway's manifest boundary.
    }
  }
  return { apps, automations };
}

function safeJson(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function defaultCloneResult(body: string): Record<string, unknown> {
  const templateId = (safeJson(body).templateId as string) ?? 'template';
  const id = `${templateId}-clone`;
  return {
    app: { id, name: 'Cloned app', description: '', kind: 'app' },
    template: {
      id: templateId,
      name: 'Template',
      desc: '',
      colorKey: 'violet',
      iconKey: 'Todo',
      version: '1',
      kind: 'app',
    },
    webhooks: [],
  };
}

function defaultAutomationRow(body: string): Record<string, unknown> {
  const parsed = safeJson(body);
  const id = (parsed.id as string) ?? 'auto-1';
  return {
    id,
    dir: `/${id}`,
    name: (parsed.name as string) ?? 'New automation',
    ref: `${id}/${id}`,
    enabled: false,
    triggers: [],
    ownerApp: id,
    manifest: {
      name: (parsed.name as string) ?? 'New automation',
      version: '1',
      enabled: false,
      prompt: '',
      triggers: [],
      requires: {},
      history: { keep: 'all' },
      generated: { by: 'test', at: '2024-01-01T00:00:00Z' },
    },
  };
}

// ─────────────────────────── environment ───────────────────────────

export interface TestEnv {
  workspace: string;
  userData: string;
  gatewayId: string;
  appsDir: string;
}

export async function makeEnv(): Promise<TestEnv> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-e2e-'));
  const userData = path.join(workspace, 'userData');
  await fs.mkdir(userData, { recursive: true });
  const gatewayId = crypto.randomUUID();
  const appsDir = path.join(userData, 'gateways', gatewayId, 'apps');
  await fs.mkdir(appsDir, { recursive: true });
  return { workspace, userData, gatewayId, appsDir };
}

export async function cleanupEnv(env: TestEnv): Promise<void> {
  await fs.rm(env.workspace, { recursive: true, force: true });
}

/**
 * Seed a REMOTE gateway profile pointing at the mock, mark it active, and
 * (by default) mark onboarding complete so the app boots straight to home.
 * Pass `{ onboarding: true }` to leave onboarding pending (the first-run view).
 */
export async function seedRemoteGateway(
  env: TestEnv,
  gateway: { url: string },
  opts: { onboarding?: boolean } = {},
): Promise<void> {
  const gwDir = path.join(env.userData, 'gateways', env.gatewayId);
  await fs.mkdir(gwDir, { recursive: true });
  await fs.writeFile(
    path.join(gwDir, 'profile.json'),
    JSON.stringify(
      {
        id: env.gatewayId,
        kind: 'remote',
        label: 'E2E Gateway',
        displayName: 'E2E Gateway',
        url: gateway.url,
        createdAt: '2024-01-01T00:00:00.000Z',
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(env.userData, 'centraid-settings.json'),
    JSON.stringify(
      {
        activeGatewayId: env.gatewayId,
        builderEnabled: true,
        changelogSeenVersion: '0.1.0',
        remoteTemplatesUrl: '',
        ...(opts.onboarding ? {} : { onboardingCompletedAt: '2024-01-01T00:00:00.000Z' }),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

export async function launchApp(env: TestEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const desktopRoot = path.resolve(__dirname, '..', '..');
  const main = path.join(desktopRoot, 'dist', 'main.js');
  await fs.access(main).catch(() => {
    throw new Error(
      `dist/main.js not found at ${main}. Run \`npm run build\` in apps/desktop first.`,
    );
  });
  // Launch through a test-only entry that applies e2e-specific main-process
  // setup (the Linux keyring backend switch) and then loads the real app, so
  // production main.ts stays free of any test/CI/platform branches. Electron
  // resolves the app root by walking up to apps/desktop/package.json, so the
  // app behaves identically to launching `desktopRoot` directly.
  const entry = path.join(__dirname, 'electron-entry.mjs');
  const app = await _electron.launch({
    args: [entry, `--user-data-dir=${env.userData}`],
    env: { ...process.env, NODE_ENV: 'test' },
  });
  const page = await app.firstWindow();
  page.on('pageerror', (error) => {
    process.stderr.write(`[desktop-e2e pageerror] ${error.stack ?? error.message}\n`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      process.stderr.write(`[desktop-e2e console] ${message.text()}\n`);
    }
  });
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

// ─────────────────────────── DOM helpers ───────────────────────────

/** A published-app metadata row for the gateway's listApps response. */
export function appEntry(over: Partial<AppMetaEntry> & { id: string }): AppMetaEntry {
  return {
    ...over,
    name: over.name ?? over.id,
    kind: over.kind ?? 'app',
    hasIndex: over.hasIndex ?? true,
  };
}

/** Build a CentraidAutomationRow for the listAutomations / read responses. */
export function automationRow(over: {
  id: string;
  name?: string;
  enabled?: boolean;
  triggers?: Array<Record<string, unknown>>;
  description?: string;
}): Record<string, unknown> {
  const id = over.id;
  const ref = `${id}/${id}`;
  const triggers = over.triggers ?? [{ kind: 'cron', expr: '0 9 * * *' }];
  return {
    id,
    dir: `/${id}`,
    name: over.name ?? id,
    ref,
    enabled: over.enabled ?? true,
    triggers,
    ownerApp: id,
    manifest: {
      name: over.name ?? id,
      version: '1',
      description: over.description ?? '',
      enabled: over.enabled ?? true,
      prompt: 'Do the thing.',
      triggers,
      requires: { model: 'tier-deep' },
      history: { keep: 'all' },
      generated: { by: 'test', at: '2024-01-01T00:00:00Z' },
    },
  };
}

/** Build a CentraidAutomationRunRecord. */
export function runRecord(over: {
  runId: string;
  automationId: string;
  ok?: boolean;
  summary?: string;
  error?: string;
  triggerKind?: string;
  triggerOrigin?: string;
}): Record<string, unknown> {
  return {
    runId: over.runId,
    kind: 'automation',
    automationId: over.automationId,
    triggerKind: over.triggerKind ?? 'manual',
    triggerOrigin: over.triggerOrigin ?? 'manual',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_002_500,
    ok: over.ok ?? true,
    ...(over.summary ? { summary: over.summary } : {}),
    ...(over.error ? { error: over.error } : {}),
    pinned: false,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCostUsd: 0.001,
    stepCount: 1,
    toolCount: 1,
  };
}

/** Build a CentraidAutomationRunNode. */
export function runNode(over: {
  runId: string;
  ordinal: number;
  kind?: string;
  name?: string;
  ok?: boolean;
  argsJson?: string;
  outputJson?: string;
  error?: string;
}): Record<string, unknown> {
  return {
    nodeId: `${over.runId}-n${over.ordinal}`,
    runId: over.runId,
    ordinal: over.ordinal,
    kind: over.kind ?? 'tool',
    name: over.name ?? 'do_thing',
    argsJson: over.argsJson ?? '{"x":1}',
    outputJson: over.outputJson ?? '{"ok":true}',
    ok: over.ok ?? true,
    ...(over.error ? { error: over.error } : {}),
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    durationMs: 1000,
    inputTokens: 100,
    outputTokens: 50,
    model: 'tier-deep',
    provider: 'test',
  };
}

/** Mark an app "known/published" in localStorage so it isn't classed a draft. */
export async function markUserApp(
  page: Page,
  app: { id: string; name: string; desc?: string },
): Promise<void> {
  await page.evaluate((a) => {
    const KEY = 'centraid.v1.home.userApps';
    const existing = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Array<
      Record<string, unknown>
    >;
    existing.push({
      id: a.id,
      name: a.name,
      desc: a.desc ?? 'Built with Centraid.',
      iconKey: 'Todo',
      color: '#5847e0',
      colorKey: 'violet',
      centraidAppId: a.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    localStorage.setItem(KEY, JSON.stringify(existing));
  }, app);
}

/** Wait for the home shell to be present. */
export async function waitForHome(page: Page): Promise<void> {
  await page.locator('[data-sidebar]').waitFor({ state: 'visible' });
  const library = page.locator('[role="tablist"][aria-label="Filter your library by kind"]');
  try {
    await library.waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    const body = (await page.locator('body').textContent())?.replaceAll(/\s+/g, ' ').slice(0, 500);
    throw new Error(`home library did not render at ${page.url()}; shell text: ${body ?? ''}`, {
      cause: error,
    });
  }
}

/** Close Electron and wait until its OS process has exited.
 *
 * `ElectronApplication.close()` can resolve just before Chromium releases the
 * app's single-instance lock. Tests that immediately relaunch must wait for the
 * process boundary, otherwise the replacement process exits without a window.
 */
export async function closeApp(app: ElectronApplication): Promise<void> {
  const child = app.process();
  const exited =
    child.exitCode === null
      ? new Promise<void>((resolve) => child.once('exit', () => resolve()))
      : Promise.resolve();
  await app.close();
  await exited;
}

/** Click a sidebar nav item by its visible label. */
export async function gotoNav(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).click();
}

/** The grid item for an app, keyed by its stable data-app-id anchor. */
export function tile(page: Page, appId: string) {
  return page.locator(`[data-app-id="${appId}"]`);
}

/** Open an app tile (the clickable card surface). */
export async function openTile(page: Page, appId: string): Promise<void> {
  await tile(page, appId).getByTestId('app-tile').click();
}

/** Open a tile's overflow (⋯) action menu. Located by accessible role/name so
 * it survives card restyles — the class churn in #230 is exactly what broke
 * the old `.cd-card-more` selector. */
export async function openTileMenu(page: Page, appId: string): Promise<void> {
  await tile(page, appId).getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menu').waitFor({ state: 'visible' });
}

/** Click a context-menu item by text. */
export async function clickMenuItem(page: Page, text: string): Promise<void> {
  await page.getByRole('menuitem', { name: text, exact: true }).click();
}

/** Wait for the confirm modal with the given title. */
export async function expectConfirm(page: Page, title: string): Promise<void> {
  await page.getByRole('dialog', { name: title, exact: true }).waitFor({ state: 'visible' });
}

/** Click the danger "Delete" button in the open confirm modal. */
export async function confirmDelete(page: Page): Promise<void> {
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
}
