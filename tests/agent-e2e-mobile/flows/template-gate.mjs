// Per-template mobile compatibility gate (issue #263).
//
// For each bundled UI template (kind "app" in packages/blueprints/index.json)
// the flow installs it over the gateway HTTP API, opens it from the phone's
// Home tile, waits for the app's header/title to render inside the WebView,
// screenshots, and asserts the shell's error state never appeared. See
// template-gate.md for preconditions.
//
// Gateway access for the RN-side HTTP calls comes from env:
//   MAESTRO_GATEWAY_URL    (default http://127.0.0.1:18789)
//   MAESTRO_GATEWAY_TOKEN  (bearer for the install/delete calls)
//   MAESTRO_TEMPLATES      (optional comma-separated template-id subset)

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFlow } from '../lib/harness.mjs';

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

// Apps the mobile shell implements NATIVELY rather than as a WebView. Home
// filters these out of the remote app list (`NATIVE_APPS` in
// apps/mobile/src/screens/Home.tsx) and `openApp` navigates to a native screen
// for each, so there is no web document to assert against — this gate's whole
// premise ("the template's own <h1> rendered inside the WebView") does not
// apply to them. They are excluded here rather than asserted loosely: a gate
// that cannot fail is worse than one that does not run.
//
// Keep in sync with NATIVE_APPS. The sync is manual because that list lives in
// TSX the flow cannot import; the cost of drift is a WebView app silently going
// ungated, so treat this list as load-bearing.
const NATIVE_ON_MOBILE = new Set(['photos', 'docs', 'agenda']);

// UI templates only — automations have no index.html to open on the phone.
async function uiTemplates() {
  const raw = await readFile(path.join(REPO_ROOT, 'packages', 'blueprints', 'index.json'), 'utf8');
  const index = JSON.parse(raw);
  return index.templates
    .filter((t) => (t.kind ?? 'app') === 'app')
    .filter((t) => !NATIVE_ON_MOBILE.has(t.id))
    .filter((t) => ONLY.length === 0 || ONLY.includes(t.id));
}

// The in-WebView marker: the template's own <h1> (falling back to <title>).
// Install is in place and copies nothing, so the served markup IS the
// template's own index.html — this is the text that proves the web document
// actually rendered. The native AppHeader alone shows the name even when the
// WebView 401s or errors.
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

  const installed = [];
  const failures = [];
  try {
    // Install everything up front so a single Home refresh sees all tiles.
    //
    // `_install`, not `_clone`: since #434 a bundled blueprint app is installed
    // IN PLACE — a consent row plus grants, with zero code copied — and the
    // clone route now rejects bundled ids outright ("is a bundled app — install
    // it via /centraid/_apps/_install, not clone"). This flow filters to
    // `kind === 'app'`, which is exactly the bundled set, so every id here
    // takes the install path. Automation templates still clone, since the
    // hidden builder is their compiler.
    for (const tmpl of templates) {
      const res = await gw('/centraid/_apps/_install', {
        body: JSON.stringify({ templateId: tmpl.id }),
        method: 'POST',
      });
      installed.push({
        appId: res.app.id,
        appName: res.app.name,
        templateId: tmpl.id,
        // Install is idempotent and reports whether the row already existed.
        // Only tear down what THIS run created — deleting an app the vault
        // already had would be a side effect the flow has no business causing.
        preexisting: res.alreadyInstalled === true,
      });
      ctx.note(
        `installed ${tmpl.id} -> ${res.app.id} ("${res.app.name}")` +
          (res.alreadyInstalled === true ? ' [already present — will not delete]' : ''),
      );
    }

    for (const c of installed) {
      const marker = await templateMarker(c.templateId);
      // Accept either the template's own header text or the registered app
      // name — the HTML header and app.json need not agree.
      const webMarker =
        marker && marker !== c.appName
          ? `(${escapeRe(marker)}|${escapeRe(c.appName)})`
          : escapeRe(c.appName);
      try {
        // Relaunch per template: React Navigation state isn't persisted, so
        // a fresh launch always lands on Home (and Home re-fetches on focus).
        //
        // The tile is selected by its accessibility label, "Open <name>", not
        // by the tile's own title text. The card is a Pressable carrying
        // `accessibilityRole="button"` + `accessibilityLabel={`Open ${name}`}`
        // (apps/mobile/src/screens/Home.tsx), which makes it a single
        // accessibility element on iOS and collapses its children — so the
        // inner <Text>{name}</Text> is not exposed as its own node. Matching
        // the raw title failed with `ElementNotFound: Text matching regex:
        // Tasks` for all five WebView apps in ci run 29765712825, while the
        // screenshot plainly showed the tile. The label is what the product
        // deliberately publishes as this control's accessible name, so it is
        // the honest thing to drive.
        await ctx.run(
          `appId: ${ctx.state.appId}
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
      text: "Open ${c.appName}"
    direction: DOWN
- tapOn:
    text: "Open ${c.appName}"
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
    // Best-effort cleanup so repeat runs start from a known state. Skips
    // anything that was already installed before this run.
    for (const c of installed.filter((entry) => !entry.preexisting)) {
      try {
        await gw(`/centraid/_apps/${encodeURIComponent(c.appId)}`, { method: 'DELETE' });
      } catch (err) {
        ctx.note(`cleanup: could not delete ${c.appId} — ${err.message.split('\n')[0]}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `template gate failed for ${failures.length}/${installed.length}:\n${failures.join('\n')}`,
    );
  }
  return {
    pass: true,
    notes: `all ${installed.length} UI templates rendered in the mobile WebView`,
  };
});
