/* oxlint-disable typescript-eslint/ban-ts-comment -- the package tsconfig has
   no DOM lib (this "src" is node-side); this test boots the scaffolded React
   app under jsdom, so DOM globals are runtime-real but invisible to tsc. */
// @ts-nocheck
// @vitest-environment jsdom
// End-to-end gate for the React builder pipeline: the scaffold's app.jsx must
// survive the SAME transform the gateway applies at serve time and then
// actually boot. This is the seam test across three separately-owned pieces —
// scaffold-files.ts (the JSX source), app-engine's static-server (the esbuild
// transform + specifier rewrite), and kit/react-core.min.js + kit/jsx-runtime.js
// (the vendored runtime the output imports). A drift in any one of them
// (scaffold imports something the bundle doesn't export, transform options
// change, jsx-runtime shim renamed) fails here before it reaches a preview.
//
// Errors are trapped on `process`, not `window` — same lesson as
// app-boot-harness.ts: an un-awaited async throw becomes a NODE unhandled
// rejection that jsdom never surfaces and vitest prints without failing.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scaffoldAppFiles } from './scaffold-files.js';

const PKG = process.cwd();
// Inside the package (vite refuses dynamic imports outside the project root);
// under .app-boot/ so the existing gitignore entry covers it.
const DIR = path.join(PKG, '.app-boot', '_scaffold');

// MUST match the gateway's serve-time transform — see transformJsx() in
// packages/app-engine/src/http/static-server.ts (options + specifier rewrite).
// Duplicated here because the blueprints package doesn't depend on app-engine;
// if the transform there changes, change this too or this gate goes stale.
// Via the CLI, not the JS API: esbuild's JS entry refuses to load under the
// jsdom environment (jsdom's Uint8Array is a different realm than the one
// TextEncoder returns, tripping its startup invariant).
function transformLikeTheGateway(source: string): string {
  const bin = path.resolve(PKG, '../..', 'node_modules/.bin/esbuild');
  const code = execFileSync(bin, ['--loader=jsx', '--jsx=automatic', '--jsx-import-source=.'], {
    input: source,
    encoding: 'utf8',
  });
  return code.replace(/(["'])\.\/jsx-runtime\1/g, '$1./jsx-runtime.js$1');
}

/** Lets the un-awaited initial refresh() and React's commit settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

describe('scaffolded React app boots through the real transform', () => {
  const errors: unknown[] = [];
  const push = (e: unknown) => errors.push(e);
  let onChangeCb: (() => void) | null = null;
  let response: unknown = {};

  beforeAll(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    const files = new Map(scaffoldAppFiles('demo', { name: 'Demo' }).map((f) => [f.path, f]));
    const appJsx = files.get('app.jsx');
    expect(appJsx, 'scaffold no longer emits app.jsx').toBeTruthy();
    const code = transformLikeTheGateway(appJsx.content);
    // Static, not just behavioral: vite resolves the extensionless
    // `./jsx-runtime` import this rewrite exists to fix, so a missing rewrite
    // would still BOOT here while 404ing in every real browser. Pin the
    // emitted specifier itself (mutation-tested: without the rewrite, only
    // these two assertions fail).
    expect(code).toContain('"./jsx-runtime.js"');
    expect(code, 'un-rewritten jsx-runtime specifier would 404 in a browser').not.toMatch(
      /(["'])\.\/jsx-runtime\1/,
    );
    writeFileSync(path.join(DIR, 'app.js'), code);
    for (const f of ['react-core.min.js', 'jsx-runtime.js']) {
      symlinkSync(path.join(PKG, 'kit', f), path.join(DIR, f));
    }

    process.on('unhandledRejection', push);
    process.on('uncaughtException', push);
    window.addEventListener('error', (e) => push(e.error ?? e.message));
  });

  afterAll(() => {
    process.off('unhandledRejection', push);
    process.off('uncaughtException', push);
    rmSync(DIR, { recursive: true, force: true });
  });

  it('renders, shows the consent banner on vaultDenied, recovers on re-grant', async () => {
    const html = scaffoldAppFiles('demo', { name: 'Demo' }).find(
      (f) => f.path === 'index.html',
    ).content;
    const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html);
    expect(body, 'scaffold index.html has no <body>').toBeTruthy();
    document.body.innerHTML = body[1];
    expect(document.querySelector('#root'), 'scaffold index.html lost its #root').toBeTruthy();

    window.centraid = {
      appId: 'demo',
      read: async () => response,
      write: async () => ({}),
      onChange: (cb) => {
        onChangeCb = cb;
        return () => {
          onChangeCb = null;
        };
      },
    };

    await import(pathToFileURL(path.join(DIR, 'app.js')).href);
    await settle();
    expect(errors, `scaffold threw booting: ${errors.map(String).join(' | ')}`).toEqual([]);
    expect(document.querySelector('main h1'), 'App component never committed').toBeTruthy();
    expect(onChangeCb, 'scaffold never subscribed via centraid.onChange').toBeTypeOf('function');

    const banner = document.querySelector('#consentBanner');
    expect(banner, 'scaffold lost its #consentBanner').toBeTruthy();
    expect(banner.hidden, 'banner should be hidden while granted').toBe(true);

    // Revoke: the change-bus callback is how the scaffold re-reads.
    response = { vaultDenied: { message: 'Grant revoked.' } };
    onChangeCb();
    await settle();
    expect(errors, `scaffold threw on revoke: ${errors.map(String).join(' | ')}`).toEqual([]);
    expect(banner.hidden, 'banner should show while denied').toBe(false);

    // Re-grant.
    response = {};
    onChangeCb();
    await settle();
    expect(errors, `scaffold threw on re-grant: ${errors.map(String).join(' | ')}`).toEqual([]);
    expect(banner.hidden, 'banner should hide after re-grant').toBe(true);
  });
});
