/*
 * Build the unpacked Companion (#1020 wave 4 lane extension).
 *
 *     node extension/scripts/build.mjs [--browser chrome|firefox] [--out dist]
 *
 * `tsc` and a copy, and that is the whole build. There is deliberately **no
 * bundler and no dependency**: the Companion imports nothing outside its own
 * `src/`, which is a property this lane created on purpose — v0's extension
 * bundles `tldts` and the Public Suffix List to decide registrable domains, and
 * that decision moved to the seat (D-1020-X8). So a release artifact is
 * reproducible from a checkout and a `tsc`, with no lockfile in the way.
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
