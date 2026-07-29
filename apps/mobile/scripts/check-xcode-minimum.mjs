#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const helpersPath = path.join(
  repoRoot,
  "node_modules",
  "react-native",
  "scripts",
  "cocoapods",
  "helpers.rb"
);

export function requiredXcodeVersion(helpers) {
  const match =
    /def self\.min_xcode_version_supported[\s\S]{0,160}?return ['"](?<version>\d+(?:\.\d+)*)['"]/u.exec(
      helpers
    );
  if (!match?.groups?.version) {
    throw new Error("React Native minimum Xcode version could not be parsed");
  }
  return match.groups.version;
}

export function installedXcodeVersion(output) {
  const match = /^Xcode\s+(?<version>\d+(?:\.\d+)*)/mu.exec(output);
  if (!match?.groups?.version) {
    throw new Error(`installed Xcode version could not be parsed: ${output}`);
  }
  return match.groups.version;
}

export function versionAtLeast(actual, required) {
  const left = actual.split(".").map(Number);
  const right = required.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return true;
}

async function recordInfraMismatch(message) {
  const directory = path.join(repoRoot, "artifacts", "e2e");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "mobile-xcode-infra.json"),
    `${JSON.stringify(
      {
        lane: "e2e",
        owner: "tests/agent-e2e-mobile/flows/home-loads.mjs",
        name: "mobile Xcode compatibility",
        status: "infra-mismatch",
        capturedAt: new Date().toISOString(),
        error: message,
        measurements: [],
      },
      null,
      2
    )}\n`
  );
}

export async function checkXcodeMinimum(options = {}) {
  const helpers = options.helpers ?? (await readFile(helpersPath, "utf8"));
  const xcodeOutput =
    options.xcodeOutput ??
    execFileSync("xcodebuild", ["-version"], {
      encoding: "utf8",
    });
  const required = requiredXcodeVersion(helpers);
  const actual = installedXcodeVersion(xcodeOutput);
  if (!versionAtLeast(actual, required)) {
    const message = `runner Xcode ${actual} is older than React Native's required ${required}`;
    await recordInfraMismatch(message);
    throw new Error(message);
  }
  return { actual, required };
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const result = await checkXcodeMinimum();
    console.log(
      `xcode-compat: installed ${result.actual}, required ${result.required}`
    );
  } catch (error) {
    console.error(
      `::error title=Mobile runner infrastructure::${error.message}`
    );
    process.exit(1);
  }
}
