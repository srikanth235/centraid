// Per-template mobile compatibility gate (issue #263).
//
// For each bundled UI template (kind "app" in packages/blueprints/index.json)
// the flow clones + publishes it over the gateway HTTP API, opens the clone
// from the phone's Home tile, waits for the app's header/title to render
// inside the WebView, screenshots, and asserts the shell's error state
// never appeared. See template-gate.md for preconditions.
//
// Gateway access for the RN-side HTTP calls comes from env:
//   MAESTRO_GATEWAY_URL    (default http://127.0.0.1:18789)
//   MAESTRO_GATEWAY_TOKEN  (bearer for the clone/publish/delete calls)
//   MAESTRO_TEMPLATES      (optional comma-separated template-id subset)

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFlow, APP_ID } from '../lib/harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const GATEWAY_URL = (process.env.MAESTRO_GATEWAY_URL ?? 'http://127.0.0.1:18789').replace(
  /\/+$/,
  '',
);
const GATEWAY_TOKEN = process.env.MAESTRO_GATEWAY_TOKEN ?? '';
const ONLY = (process.env.MAESTRO_TEMPLATES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function gw(pathname, init = {}) {
  const headers = {
    'content-type': 'application/json',
    ...(GATEWAY_TOKEN ? { authorization: `Bearer ${GATEWAY_TOKEN}` } : {}),
    ...init.headers,
  };
  const res = await fetch(`${GATEWAY_URL}${pathname}`, { ...init, headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `${init.method ?? 'GET'} ${pathname} -> HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  return text ? JSON.parse(text) : undefined;
}

// UI templates only — automations have no index.html to open on the phone.
async function uiTemplates() {
  const raw = await readFile(path.join(REPO_ROOT, 'packages', 'blueprints', 'index.json'), 'utf8');
  const index = JSON.parse(raw);
  return index.templates
    .filter((t) => (t.kind ?? 'app') === 'app')
    .filter((t) => ONLY.length === 0 || ONLY.includes(t.id));
}

// The in-WebView marker: the template's own <h1> (falling back to <title>).
// Clones keep the template's index.html markup, so this is the text that
// proves the web document actually rendered — the native AppHeader alone
// shows the name even when the WebView 401s or errors.
async function templateMarker(templateId) {
  try {
    const html = await readFile(
      path.join(REPO_ROOT, 'packages', 'blueprints', 'apps', templateId, 'index.html'),
      'utf8',
    );
    const h1 = /<h1[^>]*>([^<]+)<\/h1>/.exec(html);
    if (h1) return h1[1].trim();
    const title = /<title>([^<]+)<\/title>/.exec(html);
    if (title) return title[1].trim();
  } catch {
    /* template without an index.html shouldn't be in the app list, but don't die here */
  }
  return undefined;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

await runFlow('template-gate', async (ctx) => {
  await ctx.configureGateway(GATEWAY_URL, GATEWAY_TOKEN);
  const templates = await uiTemplates();
  if (templates.length === 0) throw new Error('no UI templates found in blueprints index.json');

  const cloned = [];
  const failures = [];
  try {
    // Clone + publish everything up front so a single Home refresh sees all tiles.
    for (const tmpl of templates) {
      const res = await gw('/centraid/_apps/_clone', {
        body: JSON.stringify({ templateId: tmpl.id, publish: true }),
        method: 'POST',
      });
      cloned.push({ appId: res.app.id, appName: res.app.name, templateId: tmpl.id });
      ctx.note(`cloned ${tmpl.id} -> ${res.app.id} ("${res.app.name}")`);
    }

    for (const c of cloned) {
      const marker = await templateMarker(c.templateId);
      // Accept either the template's own header text or the clone's minted
      // name — clone rewrites app.json but not necessarily the HTML header.
      const webMarker =
        marker && marker !== c.appName
          ? `(${escapeRe(marker)}|${escapeRe(c.appName)})`
          : escapeRe(c.appName);
      try {
        // Relaunch per template: React Navigation state isn't persisted, so
        // a fresh launch always lands on Home (and Home re-fetches on focus).
        await ctx.run(
          `appId: ${APP_ID}
---
- stopApp
- launchApp:
    clearState: false
- extendedWaitUntil:
    visible:
      text: "centraid"
    timeout: 30000
- scrollUntilVisible:
    element:
      text: "${c.appName}"
    direction: DOWN
- tapOn:
    text: "${c.appName}"
- extendedWaitUntil:
    visible:
      text: "${webMarker}"
    timeout: 30000
- assertNotVisible: "Could not load app"
- assertNotVisible: "Not connected"
- takeScreenshot: ${c.appId}
`,
          c.templateId,
        );
        ctx.note(`${c.templateId}: rendered (marker "${marker ?? c.appName}")`);
      } catch (err) {
        failures.push(`${c.templateId}: ${err.message.split('\n')[0]}`);
        ctx.note(`${c.templateId}: FAILED — ${err.message.split('\n')[0]}`);
      }
    }
  } finally {
    // Best-effort cleanup so repeat runs don't accumulate "Notes 2, Notes 3…".
    for (const c of cloned) {
      try {
        await gw(`/centraid/_apps/${encodeURIComponent(c.appId)}`, { method: 'DELETE' });
      } catch (err) {
        ctx.note(`cleanup: could not delete ${c.appId} — ${err.message.split('\n')[0]}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `template gate failed for ${failures.length}/${cloned.length}:\n${failures.join('\n')}`,
    );
  }
  return {
    pass: true,
    notes: `all ${cloned.length} UI templates rendered in the mobile WebView`,
  };
});
