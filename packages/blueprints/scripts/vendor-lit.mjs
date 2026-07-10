// Regenerates `kit/lit-core.min.js` — the runtime-only Lit bundle the kit's
// native Web Components import (issue #327). The kit is served as-is with NO
// build step, so it needs Lit as a single self-contained, browser-loadable ESM
// file rather than the npm package's bare-specifier module graph. This script
// bundles exactly the Lit entry points the kit uses out of the workspace-pinned
// `lit` devDependency (see packages/blueprints/package.json), in production mode
// (no dev-mode warnings, ~15 KB). Run it after bumping the `lit` version:
//
//   node packages/blueprints/scripts/vendor-lit.mjs
//
// Provenance: the output is derived solely from the lockfile-pinned `lit`
// package — never fetched from a CDN — so `bun install` + this script fully
// reproduce it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_DIR = path.resolve(fileURLToPath(import.meta.url), '../../kit');
const OUT = path.join(KIT_DIR, 'lit-core.min.js');
const litVersion = JSON.parse(
  readFileSync(path.resolve(KIT_DIR, '../../..', 'node_modules/lit/package.json'), 'utf8'),
).version;

// Bun resolves bare specifiers against the workspace node_modules; the entry
// must live inside the repo tree for that resolution to work.
const scratch = mkdtempSync(path.join(KIT_DIR, '.vendor-lit-'));
const entry = path.join(scratch, 'entry.js');
writeFileSync(
  entry,
  [
    // Core + standalone `render` — apps render Lit templates into kit-owned
    // containers (popover/modal build callbacks) as well as via components.
    "export { LitElement, html, svg, css, nothing, noChange, render } from 'lit';",
    // The directives the app layer needs: keyed lists, conditional classes,
    // input values that must win over user edits, and element refs.
    "export { repeat } from 'lit/directives/repeat.js';",
    "export { classMap } from 'lit/directives/class-map.js';",
    "export { live } from 'lit/directives/live.js';",
    "export { ref, createRef } from 'lit/directives/ref.js';",
    '',
  ].join('\n'),
);

try {
  execFileSync(
    'bun',
    ['build', entry, '--minify', '--format=esm', '--conditions=production', `--outfile=${OUT}`],
    { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' } },
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const banner =
  `/*! Lit ${litVersion} — vendored runtime bundle for the Centraid blueprint kit (issue #327).\n` +
  ` * Self-contained ESM (LitElement, html, svg, css, nothing, noChange, render,\n` +
  ` * repeat, classMap, live, ref, createRef), production build.\n` +
  ` * Do NOT hand-edit: regenerate with \`node packages/blueprints/scripts/vendor-lit.mjs\`.\n` +
  ` * Upstream: lit@${litVersion} (BSD-3-Clause, Google LLC). */\n`;
writeFileSync(OUT, banner + readFileSync(OUT, 'utf8'));

console.log(`Wrote ${OUT} from lit@${litVersion}`);
