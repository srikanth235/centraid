#!/usr/bin/env bun
// Visual-verification harness for the docs/photos/tasks blueprint apps.
//
// Serves the two apps EXACTLY the way the real gateway does — same
// `serveStatic()` from packages/app-engine/src/http/static-server.ts (real
// per-request esbuild JSX transform, real SHARED_ASSET_FILES fallback to
// packages/blueprints/kit, real CSP + nonce stamping) — but with zero
// gateway/vault behind it. In place of the real change-bridge's
// `window.centraid.read/write` (which POST to a live vault), every served
// index.html gets `mock-centraid.js` injected as an inline script, stamped
// with the same per-response CSP nonce static-server.ts already minted for
// its own injected change-bridge script, so it clears
// `script-src 'self' 'nonce-<n>'` without relaxing the CSP at all.
//
// Run: bun packages/blueprints/visual-harness/server.mjs
// (also wired as the "visual-harness" launch.json config, port 4173)
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Imported straight from source — bun runs .ts directly, no build step, and
// this is the whole point of the harness: exercise the REAL serveStatic.
import { serveStatic } from '../../app-engine/src/http/static-server.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const APPS_DIR = path.join(REPO_ROOT, 'packages/blueprints/apps');
const KIT_DIR = path.join(REPO_ROOT, 'packages/blueprints/kit');
const MOCK_SCRIPT_FILE = path.join(__dirname, 'mock-centraid.js');

const PORT = 4173;
const SUPPORTED_APPS = new Set(['docs', 'photos', 'tasks']);
const BLOB_PREFIX = '/centraid/_vault/blobs';

// ---------------------------------------------------------------------
// A minimal stand-in for node's ServerResponse, just enough of the surface
// `serveStatic` (and the `sendError` it falls back to) touches: statusCode,
// setHeader, end(buf). Letting serveStatic run against this instead of the
// real response object is what makes post-processing its HTML output
// possible — the real serveStatic calls `res.end(buf)` itself, so there is
// no other seam to intercept the body it produces.
// ---------------------------------------------------------------------
class CaptureResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = {};
    this.body = Buffer.alloc(0);
  }
  setHeader(name, value) {
    this.headers[name] = value;
  }
  getHeader(name) {
    return this.headers[name];
  }
  end(chunk) {
    if (chunk == null) this.body = Buffer.alloc(0);
    else if (Buffer.isBuffer(chunk)) this.body = chunk;
    else this.body = Buffer.from(String(chunk));
  }
}

let mockScriptCache = null;
async function mockScriptSource() {
  if (mockScriptCache == null) mockScriptCache = await fs.readFile(MOCK_SCRIPT_FILE, 'utf8');
  return mockScriptCache;
}

/**
 * Serve one app-relative path through the real `serveStatic`, then — for an
 * HTML response only — inject our mock `window.centraid` as an inline
 * <script>, stamped with the SAME nonce `serveStatic` minted for its own
 * injected change-bridge script (extracted back out of the CSP header it
 * just set on the captured response). Inserted immediately before the app's
 * `<script type="module">` tag: after the real bridge (which it fully
 * replaces — the bridge's `window.centraid = window.centraid || {}` merge
 * means whichever script runs LAST wins each key) and before any app code
 * touches `window.centraid`.
 */
async function serveAppAsset(res, appId, rel) {
  const appDir = path.join(APPS_DIR, appId);
  const cap = new CaptureResponse();
  await serveStatic(cap, appDir, rel, { sharedAssetsDir: KIT_DIR });

  const contentType = String(cap.headers['Content-Type'] || '');
  let body = cap.body;
  if (cap.statusCode === 200 && contentType.startsWith('text/html')) {
    let html = body.toString('utf8');
    const csp = String(cap.headers['Content-Security-Policy'] || '');
    const nonceMatch = /nonce-([^']+)'/.exec(csp);
    const nonceAttr = nonceMatch ? ` nonce="${nonceMatch[1]}"` : '';
    const mockSrc = await mockScriptSource();
    const tag = `<script${nonceAttr}>\n${mockSrc}\n</script>\n`;
    if (/<script\s+type=["']module["']/i.test(html)) {
      html = html.replace(/<script\s+type=["']module["']/i, tag + '<script type="module"');
    } else {
      // Defensive fallback — both shipped apps have a module script, but a
      // future app might not.
      html = html.replace(/<\/body>/i, `${tag}</body>`);
    }
    body = Buffer.from(html, 'utf8');
  }

  res.statusCode = cap.statusCode;
  for (const [key, value] of Object.entries(cap.headers)) {
    if (key.toLowerCase() === 'content-length') continue; // let node recompute for the new body
    res.setHeader(key, value);
  }
  res.end(body);
}

// ---------------------------------------------------------------------
// Media/content URLs. The library/drive fixtures address every asset's
// bytes as `/centraid/_vault/blobs/<content_id>` — the same same-origin
// shape production uses for blob-backed content (issue #296; see
// `srcOf()` in both apps' queries/*.js) — so `isRenderableUri`/`loadable`
// in format.js accept it as a real image/PDF source without any app-side
// changes. `?variant=thumb` gets a smaller placeholder.
//
// POST handles the upload staging round trip (kit.js `stageFileBytes`):
// real bytes in, a real sha256 out — just never persisted, since the GET
// side below generates its placeholder purely from the id in the URL.
// ---------------------------------------------------------------------
function hashHue(id) {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

function escapeXml(s) {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
}

function placeholderSvg(id, thumb) {
  const hue = hashHue(id);
  const hue2 = (hue + 40) % 360;
  const w = thumb ? 240 : 900;
  const h = thumb ? 240 : 640;
  const fontSize = thumb ? 16 : 26;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue} 65% 58%)"/>
      <stop offset="100%" stop-color="hsl(${hue2} 70% 38%)"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="rgba(255,255,255,0.92)"
    font-family="ui-monospace,monospace" font-size="${fontSize}">${escapeXml(id)}</text>
</svg>`;
}

async function handleBlobRoute(req, res, url) {
  if (req.method === 'POST') {
    const hash = createHash('sha256');
    await new Promise((resolve, reject) => {
      req.on('data', (chunk) => hash.update(chunk));
      req.on('end', resolve);
      req.on('error', reject);
    });
    const sha256 = hash.digest('hex');
    const body = JSON.stringify({ sha256, media_type: url.searchParams.get('media_type') || null });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(body);
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    const id = decodeURIComponent(url.pathname.slice(BLOB_PREFIX.length + 1)) || 'unknown';
    const thumb = url.searchParams.get('variant') === 'thumb';
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(req.method === 'HEAD' ? undefined : placeholderSvg(id, thumb));
    return;
  }
  res.statusCode = 405;
  res.end('method not allowed');
}

// ---------------------------------------------------------------------
// `_changes` SSE stub — same handshake shape as
// packages/app-engine/src/http/changes-sse.ts's handleAppChanges, but never
// emits a `change` event (the mock fires its own in-page `onChange`
// listeners directly — see mock-centraid.js). This just keeps EventSource
// quiet: no failed-connection console spam, no 404s.
// ---------------------------------------------------------------------
function handleChangesStub(req, res, appId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(`: connected to ${appId} (visual-harness stub — no real changes)\n\n`);
  const timer = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 30_000);
  req.on('close', () => clearInterval(timer));
}

function sendPlain(res, status, text) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    if (pathname === '/' || pathname === '') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        '<!doctype html><html><body style="font:14px system-ui;padding:2rem">' +
          '<h1>Blueprint visual-verification harness</h1>' +
          '<ul>' +
          '<li><a href="/centraid/docs/">/centraid/docs/</a></li>' +
          '<li><a href="/centraid/photos/">/centraid/photos/</a></li>' +
          '<li><a href="/centraid/tasks/">/centraid/tasks/</a></li>' +
          '</ul>' +
          '<p>Knobs: <code>?empty=1</code>, <code>?denied=1</code>, <code>#theme=dark&amp;bgL=10</code></p>' +
          '</body></html>',
      );
      return;
    }

    if (pathname.startsWith(BLOB_PREFIX)) {
      await handleBlobRoute(req, res, url);
      return;
    }

    const appMatch = /^\/centraid\/([^/]+)(\/.*)?$/.exec(pathname);
    if (!appMatch) {
      sendPlain(res, 404, 'not found');
      return;
    }
    const appId = decodeURIComponent(appMatch[1]);
    if (!SUPPORTED_APPS.has(appId)) {
      sendPlain(res, 404, `unknown app: ${appId} (only docs/photos/tasks are wired up)`);
      return;
    }
    let rel = appMatch[2] || '/';

    if (rel === '/_changes') {
      handleChangesStub(req, res, appId);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendPlain(res, 405, 'method not allowed');
      return;
    }

    if (rel === '/' || rel === '') rel = '/index.html';
    await serveAppAsset(res, appId, rel);
  } catch (err) {
    console.error('[visual-harness] request failed:', err);
    if (!res.headersSent) sendPlain(res, 500, 'internal error');
  }
});

server.listen(PORT, () => {
  console.log(`visual-harness listening on http://localhost:${PORT}`);
  console.log(`  docs:   http://localhost:${PORT}/centraid/docs/`);
  console.log(`  photos: http://localhost:${PORT}/centraid/photos/`);
  console.log(`  tasks:  http://localhost:${PORT}/centraid/tasks/`);
  console.log('  knobs:  ?empty=1  ?denied=1  #theme=dark&bgL=10');
});
