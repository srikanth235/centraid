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
// SCOPE, honestly: the vault mock returns `{}`, so every collection falls back
// to empty. This proves each app loads, boots, commits its templates, clears
// them on revoke and re-renders — but it renders NO ROWS, so it cannot catch a
// regression that only manifests with content (a raw clear of a Lit-owned
// container, for instance, throws only once the template has real nodes to
// insert). Those Lit container-ownership invariants are pinned directly in
// kit-smoke.test.ts. Giving each app a populated fixture would strengthen this
// considerably; it needs one hand-written shape per app's query.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PKG = process.cwd();
// Apps import these as siblings (`./kit.js`); at rest they live only in `kit/`,
// and the gateway serves them from a shared dir (SHARED_ASSET_FILES in
// app-engine/src/http/static-server.ts). Symlinks reproduce that layout.
const SHARED = ['kit.js', 'elements.js', 'lit-core.min.js', 'react-core.min.js', 'jsx-runtime.js'];

// React-dialect apps ship app.jsx; the gateway transpiles it per-request. The
// harness mirrors that with the same transform options + specifier rewrite as
// transformJsx() in app-engine/src/http/static-server.ts — via the esbuild
// CLI, because esbuild's JS API refuses to load under the jsdom environment
// (realm-split Uint8Array trips its TextEncoder startup invariant).
function transformJsxLikeTheGateway(source: string): string {
  const bin = path.resolve(PKG, '../..', 'node_modules/.bin/esbuild');
  const code = execFileSync(bin, ['--loader=jsx', '--jsx=automatic', '--jsx-import-source=.'], {
    input: source,
    encoding: 'utf8',
  });
  return code.replace(/(["'])\.\/jsx-runtime\1/g, '$1./jsx-runtime.js$1');
}

const DENIED = { vaultDenied: { message: 'Grant revoked.' } };

function bodyOf(app: string) {
  const html = readFileSync(path.join(PKG, 'apps', app, 'index.html'), 'utf8');
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html);
  if (!body) throw new Error(`${app}/index.html has no <body>`);
  return body[1];
}

/** Lets a test settle an app's un-awaited `refresh()` and its timers. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

export function describeAppBoot(app: string) {
  describe(`${app} boots`, () => {
    let dir: string;
    const errors: unknown[] = [];
    const intervals: unknown[] = [];
    const push = (e: unknown) => errors.push(e);

    /** Fails with the app's own error, not a downstream assertion. */
    const expectNoErrors = (phase: string) => {
      expect(errors, `${app} threw while ${phase}: ${errors.map(String).join(' | ')}`).toEqual([]);
    };

    beforeAll(() => {
      // Inside the package, not os.tmpdir(): vite resolves the dynamic import
      // below and refuses to load a module outside the project root.
      dir = path.join(PKG, '.app-boot', app);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const jsx = path.join(PKG, 'apps', app, 'app.jsx');
      if (existsSync(jsx)) {
        writeFileSync(
          path.join(dir, 'app.js'),
          transformJsxLikeTheGateway(readFileSync(jsx, 'utf8')),
        );
      } else {
        cpSync(path.join(PKG, 'apps', app, 'app.js'), path.join(dir, 'app.js'));
      }
      for (const f of SHARED) symlinkSync(path.join(PKG, 'kit', f), path.join(dir, f));

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
      for (const id of intervals) clearInterval(id);
      process.off('unhandledRejection', push);
      process.off('uncaughtException', push);
      rmSync(dir, { recursive: true, force: true });
    });

    it('renders an empty granted vault, survives revoke, and re-renders', async () => {
      document.body.innerHTML = bodyOf(app);
      // Granted but empty: every collection falls back to []. Drives the real
      // template commit and the one-shot mount guards over the boot skeleton.
      let response: unknown = {};
      window.centraid = {
        appId: app,
        read: async () => response,
        write: async () => ({}),
      };

      await import(pathToFileURL(path.join(dir, 'app.js')).href);
      await settle();
      expectNoErrors('rendering an empty granted vault');

      // Revoke: every app clears its containers. They are Lit-owned by now, so
      // this is the raw-clear-corrupts-the-part-cache path.
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
