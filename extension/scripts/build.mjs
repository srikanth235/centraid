/*
 * Build the unpacked Companion (#1020 wave 4 lane extension).
 *
 *     node extension/scripts/build.mjs [--browser chrome|firefox] [--out dist]
 *
 * `tsc`, one `bun build`, and a copy.
 *
 * **No third-party code is bundled**, which is the property this lane created on
 * purpose: v0's extension bundles `tldts` and the Public Suffix List to decide
 * registrable domains, and that decision moved to the seat (D-1020-X8). So the
 * Companion imports nothing outside its own `src/` and a release artifact is
 * reproducible from a checkout.
 *
 * ## Why the content script is bundled and the worker is not
 *
 * An MV3 **service worker** may be `"type": "module"`, so `tsc`'s emitted ES
 * modules load as they are. An MV3 **content script** may not: a
 * `content_scripts` entry is a CLASSIC script, and an emitted `import` statement
 * there fails at load with `Cannot use import statement outside a module` — in
 * the page, silently, where nothing but a console anybody has to be looking at
 * says so. So `content.js` is bundled to one classic file. It is the only file
 * that is, and the bundle contains nothing but this tree's own modules.
 *
 * The one generated input is `src/methods-table.ts`, written by
 * `contracts/tools/export-extension-methods.ts` beside
 * `contracts/extension/methods.json`.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(root, "..");

function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

const browser = flag("browser", "chrome");
if (browser !== "chrome" && browser !== "firefox") {
  process.stderr.write(`--browser must be chrome or firefox, not ${browser}\n`);
  process.exit(2);
}
const out = path.resolve(root, flag("out", "dist"));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// `rootDir` keeps the emitted tree flat, so the manifest's `worker.js` is at the
// root of the unpacked directory rather than under `src/`.
execFileSync(
  "tsc",
  [
    "-p",
    path.join(root, "tsconfig.build.json"),
    "--outDir",
    out,
    "--rootDir",
    path.join(root, "src"),
  ],
  { stdio: "inherit", cwd: root }
);

// THE CONTENT SCRIPT, AS ONE CLASSIC FILE. See the header: an MV3 content
// script cannot be a module, and the failure is silent in the page.
execFileSync(
  "bun",
  [
    "build",
    path.join(root, "src/content.ts"),
    "--outfile",
    path.join(out, "content.js"),
    "--target",
    "browser",
    "--format",
    "iife",
  ],
  { stdio: "inherit", cwd: root }
);

// The manifest, the popup and the icons. The BROWSER'S manifest becomes
// `manifest.json` and the other is not shipped: an unpacked directory with two
// manifests is a directory Chrome loads and Firefox does not.
for (const entry of readdirSync(path.join(root, "static"))) {
  if (/^manifest\.(?:chrome|firefox)\.json$/u.test(entry)) continue;
  const from = path.join(root, "static", entry);
  cpSync(from, path.join(out, entry), {
    recursive: statSync(from).isDirectory(),
  });
}
cpSync(
  path.join(root, "static", `manifest.${browser}.json`),
  path.join(out, "manifest.json")
);

process.stdout.write(
  `extension: built ${browser} into ${path.relative(repo, out)}\n`
);
