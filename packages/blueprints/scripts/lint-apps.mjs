// The blueprint apps and the kit are browser ES modules: nothing in CI imports
// them, `tsc` never sees them, and the repo's root `oxlint .` explicitly
// ignores `apps/**` and `kit/**` (their vanilla-DOM idiom trips dozens of the
// shared TypeScript/React rules). That left one whole class of defect with no
// gate at all — a missing import is a `ReferenceError` on load, and only a
// human opening the app in a browser would ever see it. It happened: for one
// commit, `apps/tally/app.js` called `el()`/`h()` ~180 times without importing
// either (`git show 966dace~1:packages/blueprints/apps/tally/app.js`).
//
// So we lint these files with exactly one rule — `no-undef`, under a browser
// global set — which is precisely the "you forgot an import" check and nothing
// else. Everything else stays off, so this never becomes a style gate that
// tempts anyone to re-ignore the directory.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(fileURLToPath(import.meta.url), '../..');
// oxlint is hoisted to the workspace root, never to this package's own .bin.
const OXLINT = path.resolve(PKG, '../../node_modules/.bin/oxlint');

// An app's entry is app.jsx; oxlint parses JSX natively. Apps may split into
// further browser modules (components/*.jsx, helpers .js) which are just as
// unexecuted by CI as the entry, so the gate walks the whole app dir —
// skipping the handler dirs (queries/actions/automations), which are
// node-side modules the gateway dispatches, not page code.
const NON_UI_DIRS = new Set(['queries', 'actions', 'automations']);
function uiSources(dir, rel) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (!NON_UI_DIRS.has(e.name)) out.push(...uiSources(path.join(dir, e.name), r));
    } else if (e.name.endsWith('.jsx') || e.name.endsWith('.js')) {
      out.push(r);
    }
  }
  return out;
}
const apps = readdirSync(path.join(PKG, 'apps'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .flatMap((e) =>
    existsSync(path.join(PKG, 'apps', e.name, 'app.jsx'))
      ? uiSources(path.join(PKG, 'apps', e.name), `apps/${e.name}`)
      : [`apps/${e.name}/app.js`],
  );
const targets = [...apps, 'kit/kit.js', 'kit/elements.js', 'kit/jsx-runtime.js'];

try {
  execFileSync(
    OXLINT,
    // `-A all` clears the default `correctness` category so the config's single
    // rule is the whole gate; `-D no-undef` re-arms it as an error.
    ['-A', 'all', '-D', 'no-undef', '-c', '.oxlintrc.apps.json', ...targets],
    { cwd: PKG, stdio: 'inherit', env: process.env },
  );
} catch {
  console.error(
    '\nA blueprint app or kit module references an identifier it never imports or defines.\n' +
      'In the browser this is a ReferenceError at load — the app renders nothing.\n',
  );
  process.exit(1);
}
