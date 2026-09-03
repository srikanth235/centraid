#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function restampReleaseDate(yml, hours, nowMs = Date.now()) {
  if (!Number.isFinite(hours) || hours < 0) {
    throw new Error(`hours must be >= 0, got ${hours}`);
  }
  const target = new Date(nowMs - hours * 3600 * 1000).toISOString();
  if (!/releaseDate:/mu.test(yml)) {
    const withDate = yml.replace(
      /^(?<versionLine>version:\s*.+)$/mu,
      `$<versionLine>\nreleaseDate: '${target}'`
    );
    if (withDate === yml) {
      return {
        text: `${yml.trimEnd()}\nreleaseDate: '${target}'\n`,
        releaseDate: target,
      };
    }
    return { text: withDate, releaseDate: target };
  }
  const text = yml.replace(/^releaseDate:\s*.+$/mu, `releaseDate: '${target}'`);
  return { text, releaseDate: target };
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    const sample =
      "version: 0.1.0\npath: Centraid-0.1.0-arm64.dmg\nreleaseDate: '2020-01-01T00:00:00.000Z'\n";
    const { text, releaseDate } = restampReleaseDate(
      sample,
      72,
      Date.parse("2026-01-10T12:00:00.000Z")
    );
    if (!text.includes(releaseDate)) {
      console.error("self-test failed");
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, releaseDate }));
    process.exit(0);
  }

  let hours = null;
  let ymlPath = null;
  let outPath = null;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--hours") hours = Number(args[++i]);
    else if (args[i] === "--yml") ymlPath = args[++i];
    else if (args[i] === "--out") outPath = args[++i];
    else if (args[i] === "--dry-run") dryRun = true;
  }

  if (hours == null || !ymlPath) {
    console.error(
      "usage: restamp-rollout.mjs --hours N --yml <file> [--out <file>] [--dry-run]"
    );
    process.exit(2);
  }
  if (!existsSync(ymlPath)) {
    console.error(`missing yml: ${ymlPath}`);
    process.exit(1);
  }

  const src = readFileSync(ymlPath, "utf8");
  const { text, releaseDate } = restampReleaseDate(src, hours);
  const dest = outPath || ymlPath;
  if (!dryRun) writeFileSync(dest, text);
  console.log(
    JSON.stringify(
      { yml: ymlPath, out: dest, hours, releaseDate, dryRun },
      null,
      2
    )
  );
}
