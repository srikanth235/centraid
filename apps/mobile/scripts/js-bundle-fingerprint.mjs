#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

export const JS_BUNDLE_PATHSPECS = [
  "apps/mobile/src",
  "apps/mobile/store",
  "apps/mobile/App.tsx",
  "apps/mobile/index.ts",
  "apps/mobile/lazy-screens.tsx",
  "apps/mobile/navigators.tsx",
  "apps/mobile/app.config.ts",
  "apps/mobile/babel.config.js",
  "apps/mobile/metro.config.js",
  "apps/mobile/package.json",
  "apps/mobile/tsconfig.json",
  "packages/client/src",
  "packages/core/src",
  "packages/design/src",
  "packages/blueprints/src",
  "packages/blueprints/apps",
  "bun.lock",
];

export function bundleInputFiles(
  cwd = REPO_ROOT,
  pathspecs = JS_BUNDLE_PATHSPECS
) {
  const out = execFileSync("git", ["ls-files", "-z", "--", ...pathspecs], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean).sort();
}

export function digestFiles(files, read) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(read(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function jsBundleFingerprint(cwd = REPO_ROOT) {
  const files = bundleInputFiles(cwd);
  if (files.length === 0) {
    throw new Error(
      "no tracked JS bundle inputs matched — refusing to emit a constant key"
    );
  }
  return digestFiles(files, (file) => readFileSync(path.join(cwd, file)));
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    process.stdout.write(jsBundleFingerprint().slice(0, 16));
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exit(1);
  }
}
