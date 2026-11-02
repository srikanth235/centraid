#!/usr/bin/env node
/**
 * D3 — GitHub Release body built from the commit subjects since the last tag.
 *   node scripts/release/release-notes.mjs --version 0.2.1 [--out path]
 */

import { writeFileSync } from "node:fs";
import path from "node:path";

import { commitsSinceLastTag, releaseNotes } from "./release-commits.mjs";

const args = process.argv.slice(2);
let version = null;
let out = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--version") version = args[++i];
  else if (args[i] === "--out") out = args[++i];
}
if (!version) {
  console.error(
    "usage: node scripts/release/release-notes.mjs --version X.Y.Z"
  );
  process.exit(2);
}
const body = releaseNotes(commitsSinceLastTag(path.resolve(".")), version);
if (out) writeFileSync(out, body);
else process.stdout.write(body);
