// governance: allow-repo-hygiene file-size-limit cohesive jsdom boot harness; the fetch/module shims, .module.css-as-JS rewrite, and per-app boot assertions must move together to mirror the gateway serve path
/* oxlint-disable typescript-eslint/ban-ts-comment -- the package tsconfig has
   no DOM lib (this "src" is node-side); this harness drives the browser apps
   under jsdom, so DOM globals are runtime-real but invisible to tsc. */
// @ts-nocheck
// Boots a blueprint app the way the v0 client does: its query-free `Root`,
// the real kit, the workspace React runtime, and a mocked `window.centraid`
// vault. The retired served adapter and its vendored React copy are not part
// of this path.
//
// Typechecking and root lint cover these modules, but neither executes their
// browser startup. Without this behavioral harness, a rendering crash reaches
// a human first.
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
import { replicaIntentInvalidations } from '../kit/intent-invalidations.js';
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
import { createElement } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Resolved from this module's own path, not process.cwd(): cwd differs
// between a root-run vitest (repo root) and a package-run vitest (this
// package's dir), but the file's own location never does.
const PKG = path.resolve(import.meta.dirname, '..');
// Apps import these as siblings (`./kit.ts`); at rest they live only in `kit/`,
// and the gateway serves them from a shared dir (SHARED_ASSET_FILES in
// app-engine/src/http/static-server.ts). Symlinks reproduce that layout.
const SHARED = [
  'kit.ts',
  'elements.js',
  'edge-upload.js',
  'turn-stream.js',
  'assistant-rich.js',
  'gfm.js',
  'code-highlight.js',
  'consent-cards.js',
  'conversation-client.js',
];

// The harness compiles the same TS/TSX source the client bundles, using the
// normal React automatic runtime. The esbuild CLI is used because its JS API
// refuses to load under the jsdom environment (realm-split Uint8Array trips
// its TextEncoder startup invariant).
const ESBUILD_BIN = path.resolve(PKG, '../..', 'node_modules/.bin/esbuild');

// Loader by extension for the client-bundled source graph.
function loaderForExt(rel: string): 'jsx' | 'tsx' | 'ts' {
  if (rel.endsWith('.tsx')) return 'tsx';
  if (rel.endsWith('.ts')) return 'ts';
  return 'jsx';
}

function transformInlineSource(source: string, rel = 'app.tsx'): string {
  const code = execFileSync(ESBUILD_BIN, [`--loader=${loaderForExt(rel)}`, '--jsx=automatic'], {
    input: source,
    encoding: 'utf8',
  });
  return (
    code
      // The gateway serves a `*.module.css` request as JS at that same URL. Vite/
      // Vitest, however, owns the `.module.css` extension and would run its own
      // CSS-modules transform over the harness's compiled JS (see
      // compileModuleCssLikeTheGateway) — garbage-parsing it and handing the app
      // a bogus class map with none of the `<style data-centraid-css-module>`
      // injection. So the harness serves that JS from a sibling
      // `*.module.css.js` file (written in beforeAll) and rewrites every relative
      // `*.module.css` import specifier to match — the `.js` tail is what keeps
      // Vite from hijacking it. Behaviour is identical to the gateway; only the
      // scratch filename differs from the app source.
      .replace(
        /(["'])((?:\.\.?\/)[^"']*\.module\.css)\1/g,
        (_m, q: string, spec: string) => `${q}${spec}.js${q}`,
      )
  );
}

// Compile a `*.module.css` to the same style-injecting, class-map-exporting JS
// module the gateway serves (app-engine's css-module.ts). Mirrored minimally
// via the esbuild CLI — esbuild's JS API refuses to load under jsdom (see the
// note above transformInlineSource), but the CLI is a subprocess and is
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
const TALLY_TRASH_ID = 'expense-airplane-trash';

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
  if (app === 'tally') {
    return {
      me: 'party-owner',
      currency: 'USD',
      friends: [],
      groups: [
        {
          group_id: 'group-airplane',
          name: 'Offline group',
          icon: '✈️',
          color: '#4E68DD',
          member_count: 1,
          owner_net_minor: 0,
        },
      ],
      trash: [
        {
          expense_id: TALLY_TRASH_ID,
          description: 'Recoverable dinner',
          amount_minor: 4200,
          group_name: 'Offline group',
          deleted_at: '2026-07-15T08:00:00.000Z',
          purge_at: null,
        },
      ],
      owe_total_minor: 0,
      owed_total_minor: 0,
    };
  }
  return {};
}

// Handler dirs are node-side modules dispatched by the gateway, never imported
// by the page — don't copy them into the boot scratch tree. `queries` stays
// out too: the boot entry is app-root.tsx (the query-free Root), so the graph
// never reaches a query module. Only the app-inline descriptor imports queries.
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

/** Lets a test settle an app's un-awaited `refresh()` and its timers. Use this
 * only where the assertion needs a QUIET window (proving something did NOT
 * happen, or did not happen twice); for "X must appear", use waitFor. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

/**
 * Polls until `predicate` holds, then returns; throws naming `what` on timeout.
 *
 * Boot calls `refresh()` without awaiting and the apps paint through React's
 * async scheduler, so the DOM that a fixed sleep observes is a guess. Measured:
 * the tally trash shelf lands 4 event-loop turns (~4ms) after its module import
 * resolves locally — 20× inside the old fixed 80ms settle — yet the loaded CI
 * runner still queried a null shelf and failed the `check` job. Dropping settle
 * to 1ms reproduces that exact failure locally, confirming a race rather than a
 * budget. So poll for the precondition instead of guessing at it.
 *
 * 4s ceiling: an order of magnitude above any observed individual wait and
 * comfortably inside the per-test budget, so a genuine regression still fails
 * with THIS message rather than vitest's opaque test timeout.
 */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// The single boot journey runs the app's real esbuild transform + jsdom render
// plus the remaining fixed settle windows; the slowest app (agenda) lands ~1.5s
// locally now that the appear-assertions poll (waitFor) instead of sleeping.
// The affected-package gate runs every package at once; Photos has crossed 8s
// under that CPU contention even though it remains sub-3s alone. Keep a
// bounded 20s journey budget rather than turning scheduler load into a false
// failure or blanketing every importer with a package-wide timeout.
const BOOT_TEST_TIMEOUT_MS = 20_000;

// The inline chrome (Chrome.tsx) mounts its consent notice — a `.kit-banner`
// carrying `id="consentBanner"` — when the vault denies a read, and unmounts it
// when the vault grants again. (The retired served islands kept a persistent
// element and toggled `hidden`; the inline tree mounts/unmounts instead, so
// "shown" is "present and not hidden".)
function consentBannerShown(): boolean {
  const banner = document.querySelector<HTMLElement>('#consentBanner');
  return banner !== null && banner.hidden === false;
}

export function describeAppBoot(
  app: string,
  options: { expectLive?: boolean; expectReplica?: boolean } = {},
) {
  describe(`${app} boots`, () => {
    let dir: string;
    let reactRoot: ReactRoot | undefined;
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
      // Mirror the client-bundled source graph into the scratch dir. TypeScript
      // is stripped and CSS modules use the app-engine-equivalent compiler.
      for (const rel of collectSources(appDir)) {
        const out = path.join(dir, rel);
        mkdirSync(path.dirname(out), { recursive: true });
        if (rel.endsWith('.jsx') || rel.endsWith('.tsx') || rel.endsWith('.ts')) {
          writeFileSync(
            out,
            transformInlineSource(readFileSync(path.join(appDir, rel), 'utf8'), rel),
          );
        } else if (rel.endsWith('.module.css')) {
          writeFileSync(
            `${out}.js`,
            compileModuleCssLikeTheGateway(path.join(appDir, rel), appDir, dir),
          );
        } else {
          cpSync(path.join(appDir, rel), out);
        }
      }
      for (const file of SHARED) {
        if (!existsSync(path.join(dir, file))) {
          symlinkSync(path.join(PKG, 'kit', file), path.join(dir, file));
        }
      }
      if (app === 'photos') {
        execFileSync(
          ESBUILD_BIN,
          [
            path.resolve(PKG, '../client/src/video-frame.ts'),
            '--bundle',
            '--format=esm',
            '--platform=browser',
            '--log-level=silent',
            `--outfile=${path.join(dir, 'video-frame.js')}`,
          ],
          { encoding: 'utf8' },
        );
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
      reactRoot?.unmount();
      for (const id of intervals) clearInterval(id);
      process.off('unhandledRejection', push);
      process.off('uncaughtException', push);
      rmSync(dir, { recursive: true, force: true });
    });

    it(
      'renders its replica while offline, survives revoke, and re-renders',
      { timeout: BOOT_TEST_TIMEOUT_MS },
      async () => {
        document.body.innerHTML = '<div id="appRoot"></div>';
        if (app === 'agenda') {
          // Schedule view renders the populated fixture independent of the
          // machine's current month, keeping this browser journey deterministic.
          document.documentElement.dataset.appDefaultView = 'schedule';
        }
        const granted = options.expectLive || options.expectReplica ? replicaFixture(app) : {};
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

        const module = await import(pathToFileURL(path.join(dir, 'app-root.tsx')).href);
        reactRoot = createRoot(document.getElementById('appRoot')!);
        reactRoot.render(createElement(module.Root, { rootRef: () => {} }));
        await settle();
        expectNoErrors('rendering its granted replica in airplane mode');

        if (app === 'tally' && options.expectReplica) {
          await waitFor(
            () => document.querySelector('[aria-label="Trashed expenses"]') !== null,
            "Tally's trash shelf to render from the local replica",
          );
          const shelf = document.querySelector('[aria-label="Trashed expenses"]');
          expect(shelf?.textContent).toContain('Recoverable dinner');
          const restore = Array.from(
            shelf?.querySelectorAll<HTMLButtonElement>('button') ?? [],
          ).find((button) => button.textContent?.trim() === 'Restore');
          expect(restore, 'Tally trash shelf lost its restore control').toBeTruthy();
          restore?.click();
          await waitFor(
            () => writeCalls.length > 0,
            "Tally's restore click to reach the vault write path",
          );
          expect(writeCalls).toContainEqual({
            action: 'restore-expense',
            input: { expense_id: TALLY_TRASH_ID },
          });
        }

        if (options.expectLive) {
          await waitFor(() => live.size > 0, `${app} to subscribe to its replica read`);
          const bootReads = readCalls;
          expect(bootReads, `${app} issued an unbounded initial read fanout`).toBeLessThanOrEqual(
            2,
          );
          expect(networkCalls, `${app} blocked local paint on the network`).toEqual([]);
          expect(live.size, `${app} never subscribed to its replica read`).toBeGreaterThan(0);

          if (app === 'agenda') {
            const askToCancel = () =>
              Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
                (button) => button.textContent?.trim() === 'Ask to cancel',
              );
            await waitFor(
              () => document.querySelector('.ag-sched-title') !== null,
              "Agenda's schedule row to render from the local replica",
            );
            const event = document.querySelector('.ag-sched-title');
            expect(event?.textContent).toBe(AGENDA_TITLE);
            event?.closest('button')?.click();
            await waitFor(() => askToCancel() !== undefined, "the Agenda event's drawer to open");
            const cancel = askToCancel();
            expect(cancel, 'populated Agenda event did not open its drawer').toBeTruthy();
            cancel?.click();
            cancel?.click();
            // waitFor lands the first write; settle then holds a quiet window so
            // the exactly-one assertion below still proves the second click was
            // deduped rather than merely not yet delivered.
            await waitFor(() => writeCalls.length > 0, "Agenda's cancel ask to reach the vault");
            await settle();
            expect(writeCalls).toEqual([
              {
                action: 'cancel-event',
                input: { event_id: AGENDA_EVENT_ID },
                optimistic: undefined,
              },
            ]);
            expect(readCalls, 'offline interaction unexpectedly re-read the replica').toBe(
              bootReads,
            );
            expect(networkCalls, 'offline interaction attempted a network request').toEqual([]);
            await waitFor(
              () => document.querySelector('.kit-pending-chip') !== null,
              "Agenda's pending chip to paint for the queued cancel",
            );
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
            await waitFor(
              () => document.querySelector('.kit-pending-chip') === null,
              "Agenda's pending chip to settle on the exact denial",
            );
            expect(document.querySelector('.kit-pending-chip')).toBeNull();
            expect(document.body.textContent).toContain(AGENDA_TITLE);
            expect(readCalls, 'exact intent settlement unexpectedly re-read the replica').toBe(
              bootReads,
            );
          } else if (app === 'photos') {
            await waitFor(
              () => document.querySelector(`[data-asset-id="${PHOTO_ASSET_ID}"]`) !== null,
              "Photos' local asset tile to render from the local replica",
            );
            const tile = document.querySelector(`[data-asset-id="${PHOTO_ASSET_ID}"]`);
            expect(tile, 'the populated local Photos row did not render').toBeTruthy();
            expect(tile?.querySelector('img')?.alt).toBe(PHOTO_TITLE);
          }

          response = DENIED;
          for (const listener of Array.from(live)) listener(response);
          await waitFor(
            consentBannerShown,
            `${app} to reveal its consent banner for a denied live replica value`,
          );
          expectNoErrors('applying a denied live replica value');
          expect(consentBannerShown(), `${app} ignored a denied live replica value`).toBe(true);

          response = granted;
          for (const listener of Array.from(live)) listener(response);
          await waitFor(
            () => !consentBannerShown(),
            `${app} to hide its consent banner for a re-granted live replica value`,
          );
          expectNoErrors('applying a re-granted live replica value');
          expect(consentBannerShown(), `${app} ignored a re-granted live replica value`).toBe(
            false,
          );

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
          await waitFor(
            () => readCalls > beforeFailure,
            `${app} to attempt the replacement live read`,
          );
          expect(readCalls, `${app} did not attempt the replacement live read`).toBeGreaterThan(
            beforeFailure,
          );
          const afterFailure = readCalls;
          const table = app === 'photos' ? 'core.content_item' : 'core.event';
          for (const listener of changes) listener({ tables: [table] });
          await waitFor(
            () => readCalls > afterFailure && live.size > 0,
            `${app} to retry its rejected live read on the compatibility doorbell`,
          );
          expect(
            readCalls,
            `${app} suppressed the compatibility retry after its live read rejected`,
          ).toBeGreaterThan(afterFailure);
          expect(live.size, `${app} did not restore a managed live dependency`).toBeGreaterThan(0);
          return;
        }

        // Revoke: every app clears its board and the inline Chrome renders its
        // consent notice in its place. Required, not optional — a guarded check
        // would silently skip the only assertion proving the denied read landed.
        response = DENIED;
        window.dispatchEvent(new Event('focus'));

        await waitFor(
          consentBannerShown,
          `${app} to reveal its consent banner after the grant was revoked`,
        );
        expectNoErrors('clearing after the grant was revoked');
        expect(consentBannerShown(), `${app} hid its consent banner while denied`).toBe(true);

        // Re-grant: the consent banner unmounts and the board renders again.
        response = {};
        window.dispatchEvent(new Event('focus'));
        await waitFor(
          () => !consentBannerShown(),
          `${app} to hide its consent banner after the grant came back`,
        );
        expectNoErrors('re-rendering after the grant came back');
        expect(consentBannerShown(), `${app} kept its consent banner after re-grant`).toBe(false);
      },
    );
  });
}
