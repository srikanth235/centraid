// governance: allow-repo-hygiene file-size-limit cohesive jsdom boot harness; the fetch/module shims, .module.css-as-JS rewrite, and per-app boot assertions must move together to mirror the gateway serve path
/* oxlint-disable typescript-eslint/ban-ts-comment -- the package tsconfig has
   no DOM lib (this "src" is node-side); this harness drives the browser apps
   under jsdom, so DOM globals are runtime-real but invisible to tsc. */
// @ts-nocheck
// Boots a blueprint app the way a browser does: its real `index.html` body,
// its real `app.js`, the real kit, and a mocked `window.centraid` vault.
//
// Nothing else in CI executes these modules — they are browser ES modules that
// `tsc` never sees and the root oxlint config ignores (see scripts/lint-apps.mjs
// for the sibling gate). Without this, a rendering crash reaches a human first.
//
// THREE constraints, each verified empirically. Break one and the gate passes
// while the app is broken:
//
//  1. Errors MUST be trapped on `process`, not `window`. Boot calls `refresh()`
//     without awaiting, so a throw inside becomes a NODE unhandled rejection:
//     jsdom never fires window 'unhandledrejection' for it, and vitest prints
//     it WITHOUT failing the test. (Proven by injecting a throw into refresh.)
//  2. ONE app per process, and ONE module import per process. Apps install
//     resize/interval timers that outlive a test and would then observe another
//     app's DOM; and locker/people call `customElements.define()` at module
//     scope, so a second import of any app.js in the same process throws
//     "already defined". Hence one `<app>.test.ts` file each — vitest's default
//     forks pool isolates per FILE, not per test.
//  3. The apps' consent paths are driven by re-reading, not re-importing. Every
//     app re-runs `refresh()` on window 'focus', so flipping the mock and
//     dispatching focus walks granted → denied → granted on a single instance.
//
// Agenda and Photos additionally boot populated replica fixtures. Agenda's
// pending-chip assertions consume the production intent-invalidation
// derivation, so the harness cannot invent a terminal browser signal that the
// real coordinator would never publish.
import { replicaIntentInvalidations } from '@centraid/client/replica/intent-invalidations';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Resolved from this module's own path, not process.cwd(): cwd differs
// between a root-run vitest (repo root) and a package-run vitest (this
// package's dir), but the file's own location never does.
const PKG = path.resolve(import.meta.dirname, '..');
// Apps import these as siblings (`./kit.js`); at rest they live only in `kit/`,
// and the gateway serves them from a shared dir (SHARED_ASSET_FILES in
// app-engine/src/http/static-server.ts). Symlinks reproduce that layout.
const SHARED = [
  'kit.js',
  'elements.js',
  'blob-format.js',
  'video-frame.js',
  'edge-upload.js',
  'turn-stream.js',
  'assistant-rich.js',
  'gfm.js',
  'code-highlight.js',
  'consent-cards.js',
  'conversation-client.js',
  'pdf.min.mjs',
  'pdf.worker.min.mjs',
  'react-core.min.js',
  'jsx-runtime.js',
];

// React-dialect apps ship app.jsx; the gateway transpiles it per-request. The
// harness mirrors that with the same transform options + depth-aware
// specifier rewrite as transformJsx()/jsxRuntimeClimb() in
// app-engine/src/http/static-server.ts — via the esbuild CLI, because
// esbuild's JS API refuses to load under the jsdom environment (realm-split
// Uint8Array trips its TextEncoder startup invariant).
//
// `depth` is the number of directory segments in the file's app-relative
// path (0 at the app root, 1 under `components/`, …) — esbuild's emitted
// `./jsx-runtime` import is resolved relative to the importing file's own
// directory, and `jsx-runtime.js` only ever lives at the app root, so a
// nested file needs a specifier that climbs back up (`../jsx-runtime.js`,
// `../../jsx-runtime.js`, …) rather than a bare `./jsx-runtime.js`.
const ESBUILD_BIN = path.resolve(PKG, '../..', 'node_modules/.bin/esbuild');

// Loader by extension, mirroring loaderForExt() in app-engine's
// static-server.ts: `.jsx`→jsx, `.tsx`→tsx, `.ts`→ts. TS-authored apps ship
// `app.tsx`/`.ts` siblings the gateway strips/compiles at serve time; the
// automatic-runtime JSX config and the depth-aware `./jsx-runtime` rewrite
// apply to `.tsx` and are inert for `.ts`.
function loaderForExt(rel: string): 'jsx' | 'tsx' | 'ts' {
  if (rel.endsWith('.tsx')) return 'tsx';
  if (rel.endsWith('.ts')) return 'ts';
  return 'jsx';
}

function transformJsxLikeTheGateway(source: string, depth: number, rel = 'app.jsx'): string {
  const code = execFileSync(
    ESBUILD_BIN,
    [`--loader=${loaderForExt(rel)}`, '--jsx=automatic', '--jsx-import-source=.'],
    { input: source, encoding: 'utf8' },
  );
  const prefix = depth === 0 ? './' : '../'.repeat(depth);
  return (
    code
      .replace(/(["'])\.\/jsx-runtime\1/g, (_m, q: string) => `${q}${prefix}jsx-runtime.js${q}`)
      // The gateway serves a `*.module.css` request as JS at that same URL. Vite/
      // Vitest, however, owns the `.module.css` extension and would run its own
      // CSS-modules transform over the harness's compiled JS (see
      // compileModuleCssLikeTheGateway) — garbage-parsing it and handing the app
      // a bogus class map with none of the `<style data-centraid-css-module>`
      // injection. So the harness serves that JS from a sibling
      // `*.module.css.js` file (written in beforeAll) and rewrites every relative
      // `*.module.css` import specifier to match — the `.js` tail is what keeps
      // Vite from hijacking it. Behaviour is identical to the gateway; only the
      // scratch filename differs (a harness accommodation, like the jsx-runtime
      // rewrite above).
      .replace(
        /(["'])((?:\.\.?\/)[^"']*\.module\.css)\1/g,
        (_m, q: string, spec: string) => `${q}${spec}.js${q}`,
      )
  );
}

// Compile a `*.module.css` to the same style-injecting, class-map-exporting JS
// module the gateway serves (app-engine's css-module.ts). Mirrored minimally
// via the esbuild CLI — esbuild's JS API refuses to load under jsdom (see the
// note above transformJsxLikeTheGateway), but the CLI is a subprocess and is
// unaffected. The CLI emits the JS class-map module and the compiled CSS as
// two files into a temp outdir; we compose the served body from both.
function compileModuleCssLikeTheGateway(absFile: string, appRoot: string, scratch: string): string {
  const work = path.join(scratch, `.cssmod-${path.basename(absFile)}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const entry = path.join(work, 'entry.js');
  writeFileSync(entry, `import m from ${JSON.stringify(absFile)};\nexport default m;\n`);
  execFileSync(
    ESBUILD_BIN,
    [
      entry,
      '--bundle',
      '--format=esm',
      '--platform=browser',
      '--loader:.module.css=local-css',
      `--outdir=${path.join(work, 'out')}`,
    ],
    { encoding: 'utf8', cwd: appRoot },
  );
  const outDir = path.join(work, 'out');
  let js = '';
  let css = '';
  for (const name of readdirSync(outDir)) {
    const body = readFileSync(path.join(outDir, name), 'utf8');
    if (name.endsWith('.css')) css = body;
    else js = body;
  }
  const key = path.relative(appRoot, absFile).split(path.sep).join('/');
  return (
    `(() => {\n` +
    `  if (typeof document === 'undefined') return;\n` +
    `  const k = ${JSON.stringify(key)};\n` +
    `  if (document.querySelector('style[data-centraid-css-module=' + JSON.stringify(k) + ']')) return;\n` +
    `  const el = document.createElement('style');\n` +
    `  el.setAttribute('data-centraid-css-module', k);\n` +
    `  el.textContent = ${JSON.stringify(css)};\n` +
    `  document.head.appendChild(el);\n` +
    `})();\n` +
    js
  );
}

const DENIED = { vaultDenied: { message: 'Grant revoked.' } };

const AGENDA_EVENT_ID = 'event-airplane';
const AGENDA_INTENT_ID = 'intent-airplane-cancel';
const AGENDA_TITLE = 'Airplane-mode planning';
const PHOTO_ASSET_ID = 'asset-airplane';
const PHOTO_TITLE = 'Airplane-mode photo';

/** Populated, clone-safe rows shaped exactly like each app's local query. */
function replicaFixture(app: string): unknown {
  if (app === 'agenda') {
    return {
      events: [
        {
          event_id: AGENDA_EVENT_ID,
          calendar_id: 'calendar-local',
          summary: AGENDA_TITLE,
          description: 'Already present in the local replica.',
          dtstart: '2099-01-15T09:00:00.000Z',
          dtend: '2099-01-15T10:00:00.000Z',
          status: 'confirmed',
          attendees: [],
          attachments: [],
        },
      ],
      calendars: [{ calendar_id: 'calendar-local', name: 'Local calendar', color: '#6f5bf6' }],
    };
  }
  if (app === 'photos') {
    return {
      assets: [
        {
          asset_id: PHOTO_ASSET_ID,
          content_id: 'content-airplane',
          title: PHOTO_TITLE,
          media_type: 'image/gif',
          content_uri: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
          thumb_uri: null,
          preview_uri: null,
          width: 320,
          height: 240,
          taken_at: '2026-07-15T08:00:00.000Z',
          favorite: 0,
          album_ids: ['album-airplane'],
          album_titles: ['Offline picks'],
          tags: [],
          place: null,
          custody_state: 'available',
        },
      ],
      albums: [{ album_id: 'album-airplane', title: 'Offline picks' }],
      places: [],
      trash: [],
      truncated: false,
      window: 500,
    };
  }
  return {};
}

// Handler dirs are node-side modules dispatched by the gateway, never
// imported by the page — don't copy them into the boot scratch tree.
const NON_UI_DIRS = new Set(['queries', 'actions', 'automations']);

/** All browser-source files of an app, as relative posix paths: `.js`/`.jsx`
 * and their TS counterparts `.ts`/`.tsx`, plus `*.module.css` (a CSS module is
 * imported by the page as JS — see compileModuleCssLikeTheGateway). */
function collectSources(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!NON_UI_DIRS.has(e.name)) out.push(...collectSources(root, r));
    } else if (
      r.endsWith('.js') ||
      r.endsWith('.jsx') ||
      r.endsWith('.ts') ||
      r.endsWith('.tsx') ||
      r.endsWith('.module.css')
    ) {
      out.push(r);
    }
  }
  return out;
}

function bodyOf(app: string) {
  const html = readFileSync(path.join(PKG, 'apps', app, 'index.html'), 'utf8');
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html);
  if (!body) throw new Error(`${app}/index.html has no <body>`);
  return body[1];
}

/** Lets a test settle an app's un-awaited `refresh()` and its timers. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

export function describeAppBoot(app: string, options: { expectLive?: boolean } = {}) {
  describe(`${app} boots`, () => {
    let dir: string;
    let entry: string;
    let originalFetch: typeof fetch;
    const errors: unknown[] = [];
    const intervals: unknown[] = [];
    const push = (e: unknown) => errors.push(e);

    /** Fails with the app's own error, not a downstream assertion. */
    const expectNoErrors = (phase: string) => {
      expect(errors, `${app} threw while ${phase}: ${errors.map(String).join(' | ')}`).toEqual([]);
    };

    beforeAll(() => {
      originalFetch = globalThis.fetch;
      // Inside the package, not os.tmpdir(): vite resolves the dynamic import
      // below and refuses to load a module outside the project root.
      dir = path.join(PKG, '.app-boot', app);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const appDir = path.join(PKG, 'apps', app);
      // React-dialect apps may span multiple source files (app.jsx entry +
      // components/*.jsx). Mirror the whole source tree into the scratch dir,
      // transforming each .jsx exactly like the gateway would per-request and
      // copying plain .js helpers verbatim. Filenames keep their .jsx
      // extension — that's what the browser requests and what inter-file
      // imports name; vite loads the (already-transformed) content fine.
      // Entry preference mirrors the gateway: a TS-authored app ships
      // `app.tsx`, a React-dialect one `app.jsx`, a vanilla one `app.js`.
      const tsxEntry = existsSync(path.join(appDir, 'app.tsx'));
      const jsxEntry = existsSync(path.join(appDir, 'app.jsx'));
      if (tsxEntry || jsxEntry) {
        entry = tsxEntry ? 'app.tsx' : 'app.jsx';
        for (const rel of collectSources(appDir)) {
          const out = path.join(dir, rel);
          mkdirSync(path.dirname(out), { recursive: true });
          if (rel.endsWith('.jsx') || rel.endsWith('.tsx') || rel.endsWith('.ts')) {
            const depth = rel.split('/').length - 1;
            writeFileSync(
              out,
              transformJsxLikeTheGateway(readFileSync(path.join(appDir, rel), 'utf8'), depth, rel),
            );
          } else if (rel.endsWith('.module.css')) {
            // Written to a `.js` sibling (imports were rewritten to match) so
            // Vite serves the harness's gateway-faithful compile as JS instead
            // of running its own CSS-modules transform over it. See
            // transformJsxLikeTheGateway.
            writeFileSync(
              `${out}.js`,
              compileModuleCssLikeTheGateway(path.join(appDir, rel), appDir, dir),
            );
          } else {
            cpSync(path.join(appDir, rel), out);
          }
        }
        // Shared assets (kit.js / react-core.min.js / jsx-runtime.js…) only
        // ever live at the app root — mirrors the gateway's root-only
        // SHARED_ASSET_FILES fallback (static-server.ts). A nested .jsx
        // file's relative imports either climb back to the root themselves
        // (`../kit.js`, `../react-core.min.js` — hand-written by the app) or,
        // for the one specifier esbuild emits automatically, via the
        // depth-aware rewrite above, so only the root needs the symlinks.
        for (const f of SHARED) {
          if (!existsSync(path.join(dir, f)))
            symlinkSync(path.join(PKG, 'kit', f), path.join(dir, f));
        }
      } else {
        entry = 'app.js';
        cpSync(path.join(appDir, 'app.js'), path.join(dir, 'app.js'));
        for (const f of SHARED) symlinkSync(path.join(PKG, 'kit', f), path.join(dir, f));
      }

      process.on('unhandledRejection', push);
      process.on('uncaughtException', push);

      // Apps set an every-second TOTP/clock interval; left running it keeps the
      // worker alive past the suite.
      const realSetInterval = globalThis.setInterval;
      globalThis.setInterval = (...args: unknown[]) => {
        const id = realSetInterval(...args);
        intervals.push(id);
        return id;
      };

      // jsdom implements neither; apps read both at boot (theme, layout).
      window.matchMedia ??= () => ({ matches: false, addEventListener() {}, addListener() {} });
      window.scrollTo ??= () => {};
      window.addEventListener('error', (e) => push(e.error ?? e.message));
    });

    afterAll(() => {
      globalThis.fetch = originalFetch;
      for (const id of intervals) clearInterval(id);
      process.off('unhandledRejection', push);
      process.off('uncaughtException', push);
      rmSync(dir, { recursive: true, force: true });
    });

    it('renders its replica while offline, survives revoke, and re-renders', async () => {
      document.body.innerHTML = bodyOf(app);
      if (app === 'agenda') {
        // Schedule view renders the populated fixture independent of the
        // machine's current month, keeping this browser journey deterministic.
        document.documentElement.dataset.appDefaultView = 'schedule';
      }
      const granted = options.expectLive ? replicaFixture(app) : {};
      let response: unknown = granted;
      let nextReadError: Error | undefined;
      let readCalls = 0;
      const networkCalls: unknown[] = [];
      const writeCalls: unknown[] = [];
      const live = new Set<(value: unknown) => void>();
      const changes = new Set<(detail: unknown) => void>();
      Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
      globalThis.fetch = async (...args: unknown[]) => {
        networkCalls.push(args[0]);
        throw new Error('synthetic airplane mode');
      };
      window.centraid = {
        appId: app,
        read: () => {
          readCalls += 1;
          const error = nextReadError;
          nextReadError = undefined;
          const result = error
            ? Promise.reject(new Error(error.message))
            : Promise.resolve(response);
          result.subscribe = (listener: (value: unknown) => void) => {
            live.add(listener);
            void result.then(listener, () => undefined);
            return () => live.delete(listener);
          };
          return result;
        },
        write: async (request: unknown) => {
          writeCalls.push(request);
          if (app === 'agenda' && (request as { action?: string }).action === 'cancel-event') {
            return { status: 'queued', intentId: AGENDA_INTENT_ID };
          }
          return {};
        },
        onChange: (listener: (detail: unknown) => void) => {
          changes.add(listener);
          return () => changes.delete(listener);
        },
      };

      const emitAgendaIntentState = (state: 'parked' | 'denied') => {
        const invalidations = replicaIntentInvalidations([
          {
            intentId: AGENDA_INTENT_ID,
            payloadHash: 'harness-payload',
            appId: 'agenda',
            action: 'cancel-event',
            input: { event_id: AGENDA_EVENT_ID },
            state,
            createdOrder: 1,
            attempts: 1,
            optimistic: [],
            dependencies: [{ shapeId: 'shape-agenda-events', entity: 'core.event' }],
          },
        ]);
        for (const invalidation of invalidations) {
          for (const listener of changes) {
            listener({ ...invalidation, tables: [invalidation.entity] });
          }
        }
      };

      await import(pathToFileURL(path.join(dir, entry)).href);
      await settle();
      expectNoErrors('rendering its granted replica in airplane mode');

      if (options.expectLive) {
        const bootReads = readCalls;
        expect(bootReads, `${app} issued an unbounded initial read fanout`).toBeLessThanOrEqual(2);
        expect(networkCalls, `${app} blocked local paint on the network`).toEqual([]);
        expect(live.size, `${app} never subscribed to its replica read`).toBeGreaterThan(0);

        if (app === 'agenda') {
          const event = document.querySelector('.ag-sched-title');
          expect(event?.textContent).toBe(AGENDA_TITLE);
          event?.closest('button')?.click();
          await settle();
          const cancel = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
            (button) => button.textContent?.trim() === 'Ask to cancel',
          );
          expect(cancel, 'populated Agenda event did not open its drawer').toBeTruthy();
          cancel?.click();
          cancel?.click();
          await settle();
          expect(writeCalls).toEqual([
            { action: 'cancel-event', input: { event_id: AGENDA_EVENT_ID }, optimistic: undefined },
          ]);
          expect(readCalls, 'offline interaction unexpectedly re-read the replica').toBe(bootReads);
          expect(networkCalls, 'offline interaction attempted a network request').toEqual([]);
          expect(document.querySelector('.kit-pending-chip')?.textContent).toBe('cancel asked');
          expect(document.body.textContent).toContain(AGENDA_TITLE);

          // Reconnect admission parks the exact queued intent: the event stays
          // canonical and the chip remains until a terminal owner decision.
          Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
          emitAgendaIntentState('parked');
          await new Promise((resolve) => setTimeout(resolve, 250));
          expect(document.querySelector('.kit-pending-chip')?.textContent).toBe('cancel asked');

          // An exact denial is the rollback signal: only this chip settles and
          // the unchanged canonical event remains visible.
          emitAgendaIntentState('denied');
          await new Promise((resolve) => setTimeout(resolve, 250));
          expect(document.querySelector('.kit-pending-chip')).toBeNull();
          expect(document.body.textContent).toContain(AGENDA_TITLE);
          expect(readCalls, 'exact intent settlement unexpectedly re-read the replica').toBe(
            bootReads,
          );
        } else if (app === 'photos') {
          const tile = document.querySelector(`[data-asset-id="${PHOTO_ASSET_ID}"]`);
          expect(tile, 'the populated local Photos row did not render').toBeTruthy();
          expect(tile?.querySelector('img')?.alt).toBe(PHOTO_TITLE);
        }

        response = DENIED;
        for (const listener of Array.from(live)) listener(response);
        await settle();
        expectNoErrors('applying a denied live replica value');
        const liveBanner = document.querySelector('#consentBanner');
        expect(liveBanner, `${app}/index.html lost its #consentBanner`).toBeTruthy();
        expect(liveBanner.hidden, `${app} ignored a denied live replica value`).toBe(false);

        response = granted;
        for (const listener of Array.from(live)) listener(response);
        await settle();
        expectNoErrors('applying a re-granted live replica value');
        expect(liveBanner.hidden, `${app} ignored a re-granted live replica value`).toBe(true);

        // A replacement live read can fail before it registers any upstream
        // dependency. The app must release that dead subscription and let a
        // later compatibility doorbell retry it.
        const beforeFailure = readCalls;
        nextReadError = new Error('synthetic initial replica read failure');
        if (app === 'photos') {
          const realNow = Date.now;
          const afterStaleWindow = realNow() + 31_000;
          Date.now = () => afterStaleWindow;
          window.dispatchEvent(new Event('focus'));
          Date.now = realNow;
        } else {
          window.dispatchEvent(new Event('focus'));
        }
        await settle();
        expect(readCalls, `${app} did not attempt the replacement live read`).toBeGreaterThan(
          beforeFailure,
        );
        const afterFailure = readCalls;
        const table = app === 'photos' ? 'core.content_item' : 'core.event';
        for (const listener of changes) listener({ tables: [table] });
        await new Promise((resolve) => setTimeout(resolve, 350));
        expect(
          readCalls,
          `${app} suppressed the compatibility retry after its live read rejected`,
        ).toBeGreaterThan(afterFailure);
        expect(live.size, `${app} did not restore a managed live dependency`).toBeGreaterThan(0);
        return;
      }

      // Revoke: every app clears its containers.
      response = DENIED;
      window.dispatchEvent(new Event('focus'));
      await settle();
      expectNoErrors('clearing after the grant was revoked');

      // Required, not optional: a guarded `if (banner)` would silently skip the
      // only assertion proving the denied read was actually observed.
      const banner = document.querySelector('#consentBanner');
      expect(banner, `${app}/index.html lost its #consentBanner`).toBeTruthy();
      expect(banner.hidden, `${app} hid its consent banner while denied`).toBe(false);

      // Re-grant: render back into the containers the denied path just cleared.
      response = {};
      window.dispatchEvent(new Event('focus'));
      await settle();
      expectNoErrors('re-rendering after the grant came back');
      expect(banner.hidden, `${app} kept its consent banner after re-grant`).toBe(true);
    });
  });
}
