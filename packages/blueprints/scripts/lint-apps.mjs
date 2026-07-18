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

// An app's entry is app.tsx (or, pre-conversion, app.jsx); oxlint parses both
// JSX and TSX natively (oxc). Apps may split into further browser modules
// (components/*.tsx, helpers .ts/.js) which are just as unexecuted by CI as the
// entry, so the gate walks the whole app dir — skipping the handler dirs
// (queries/actions/automations), which are node-side modules the gateway
// dispatches, not page code.
const NON_UI_DIRS = new Set(['queries', 'actions', 'automations']);
function isUiSource(name) {
  if (name.endsWith('.d.ts')) return false; // declarations carry no runtime refs
  return (
    name.endsWith('.tsx') || name.endsWith('.jsx') || name.endsWith('.ts') || name.endsWith('.js')
  );
}
function uiSources(dir, rel) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (!NON_UI_DIRS.has(e.name)) out.push(...uiSources(path.join(dir, e.name), r));
    } else if (isUiSource(e.name)) {
      out.push(r);
    }
  }
  return out;
}
const apps = readdirSync(path.join(PKG, 'apps'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .flatMap((e) => {
    const base = path.join(PKG, 'apps', e.name);
    // Probe the TS entry first, then the legacy JSX one; a multi-file app walks
    // its whole dir, a single-file app falls back to its lone entry.
    if (existsSync(path.join(base, 'app.tsx')) || existsSync(path.join(base, 'app.jsx'))) {
      return uiSources(base, `apps/${e.name}`);
    }
    return [
      existsSync(path.join(base, 'app.ts')) ? `apps/${e.name}/app.ts` : `apps/${e.name}/app.js`,
    ];
  });
const targets = [
  ...apps,
  'kit/kit.js',
  'kit/elements.js',
  'kit/edge-upload.js',
  'kit/jsx-runtime.js',
  'kit/turn-stream.js',
  'kit/assistant-rich.js',
  'kit/gfm.js',
  'kit/code-highlight.js',
  'kit/consent-cards.js',
  'kit/conversation-client.js',
];

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
