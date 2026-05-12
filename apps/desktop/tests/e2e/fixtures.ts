import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * One mock gateway per test. Records every request so the test can assert what
 * the renderer/main actually sent. Tunable response code lets us simulate the
 * 404 (already gone) and 500 (gateway error) branches separately.
 */
export interface MockGateway {
  url: string;
  token: string;
  /** Calls observed by the server, in arrival order. */
  calls: Array<{ method: string; pathname: string; auth?: string }>;
  /** Default 200. Set to 404, 500, etc. to drive renderer branches. */
  deleteStatus: number;
  /** Tear down the listener. After this the gateway is "unreachable". */
  close(): Promise<void>;
}

export async function startMockGateway(): Promise<MockGateway> {
  const state = {
    deleteStatus: 200,
    calls: [] as MockGateway['calls'],
  };
  const token = crypto.randomBytes(16).toString('hex');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    state.calls.push({
      method: req.method ?? 'GET',
      pathname: url.pathname,
      auth: req.headers['authorization'] as string | undefined,
    });
    if (req.method === 'DELETE' && /^\/centraid\/_apps\/[^/]+$/.test(url.pathname)) {
      res.statusCode = state.deleteStatus;
      res.setHeader('content-type', 'application/json');
      if (state.deleteStatus === 200) {
        res.end(JSON.stringify({ id: url.pathname.split('/').pop() }));
      } else if (state.deleteStatus === 404) {
        res.end(JSON.stringify({ error: 'not_found' }));
      } else {
        res.end(JSON.stringify({ error: 'server_error' }));
      }
      return;
    }
    // Any other route 200s with empty JSON so the renderer doesn't blow up on
    // ambient calls (template manifest fetches, healthz, etc.).
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('mock gateway: no address');
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    token,
    get calls() {
      return state.calls;
    },
    get deleteStatus() {
      return state.deleteStatus;
    },
    set deleteStatus(v: number) {
      state.deleteStatus = v;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

export interface TestEnv {
  workspace: string; // <tmp>/<test-id>
  userData: string; // electron --user-data-dir
  projectsDir: string;
}

export async function makeEnv(): Promise<TestEnv> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-e2e-'));
  const userData = path.join(workspace, 'userData');
  const projectsDir = path.join(workspace, 'projects');
  await fs.mkdir(userData, { recursive: true });
  await fs.mkdir(projectsDir, { recursive: true });
  return { workspace, userData, projectsDir };
}

export async function cleanupEnv(env: TestEnv): Promise<void> {
  await fs.rm(env.workspace, { recursive: true, force: true });
}

/**
 * Write <userData>/centraid-settings.json so the main process picks up our
 * mock gateway URL/token and the per-test projectsDir on startup. Mirrors
 * `apps/desktop/src/main/settings.ts` shape exactly — drift here will fail
 * loadSettings() silently and fall back to defaults.
 */
export async function seedSettings(
  env: TestEnv,
  gateway: { url: string; token: string },
): Promise<void> {
  const file = path.join(env.userData, 'centraid-settings.json');
  await fs.writeFile(
    file,
    JSON.stringify(
      {
        projectsDir: env.projectsDir,
        gatewayUrl: gateway.url,
        gatewayToken: gateway.token,
        remoteTemplatesUrl: '', // disable remote template fetching
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

/** Lay down a "published" project + matching localStorage userApp entry. */
export async function seedPublishedApp(
  env: TestEnv,
  page: Page,
  app: { id: string; name: string; desc?: string },
): Promise<void> {
  await seedProjectDir(env, app);
  await page.evaluate((a) => {
    const KEY = 'centraid.v1.home.userApps';
    const existing = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Array<Record<string, unknown>>;
    existing.push({
      id: a.id,
      name: a.name,
      desc: a.desc ?? 'Built with Centraid.',
      iconKey: 'Todo',
      color: '#5847e0',
      colorKey: 'violet',
      centraidProjectId: a.id,
    });
    localStorage.setItem(KEY, JSON.stringify(existing));
  }, app);
}

/** Lay down a draft project (no userApp entry — hydrateDrafts() will pick it up). */
export async function seedDraftProject(
  env: TestEnv,
  app: { id: string; name: string; desc?: string },
): Promise<void> {
  await seedProjectDir(env, app);
}

async function seedProjectDir(
  env: TestEnv,
  app: { id: string; name: string; desc?: string },
): Promise<void> {
  const dir = path.join(env.projectsDir, app.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'app.json'),
    JSON.stringify({ name: app.name, description: app.desc ?? '' }, null, 2),
  );
  // hasIndex: true makes the tile feel "complete" and matches a real published
  // project. The renderer doesn't currently gate delete on this, but a future
  // change might — keeping it close to the real shape is cheap insurance.
  await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html><title>seeded</title>');
}

/**
 * Launch the Electron app with a per-test userData dir. Caller must have
 * already written `centraid-settings.json` into env.userData and seeded any
 * fixture projects on disk.
 *
 * `main.js` is built from `src/main.ts`; the suite's package script should
 * run `npm run build` once before invoking playwright.
 */
export async function launchApp(env: TestEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const desktopRoot = path.resolve(__dirname, '..', '..');
  const main = path.join(desktopRoot, 'dist', 'main.js');
  await fs.access(main).catch(() => {
    throw new Error(
      `dist/main.js not found at ${main}. Run \`npm run build\` in apps/desktop first.`,
    );
  });

  const app = await _electron.launch({
    args: [desktopRoot, `--user-data-dir=${env.userData}`],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      // Belt-and-suspenders: even if settings.json is missing, the harness will
      // pick this up. The renderer doesn't read it directly.
      OPENCLAW_GATEWAY_TOKEN: '',
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

/** Open the tile's context menu via the 3-dot "More" button. */
export async function openTileMenu(page: Page, appName: string): Promise<void> {
  const tile = page.locator('.app-tile', { hasText: appName }).first();
  await tile.locator('.tile-more-btn').click();
}

/** Click "Delete" in the open context menu. */
export async function clickContextDelete(page: Page): Promise<void> {
  await page.locator('.ctx-item[data-danger="true"]', { hasText: 'Delete' }).click();
}

/** Confirm or cancel the delete modal. */
export async function expectConfirm(page: Page, expectedTitle: string): Promise<void> {
  const dialog = page.locator('.modal-card[role="dialog"]', { hasText: expectedTitle });
  await dialog.waitFor({ state: 'visible' });
}

export async function confirmDelete(page: Page): Promise<void> {
  await page.locator('.modal-card .btn-danger', { hasText: 'Delete' }).click();
}
