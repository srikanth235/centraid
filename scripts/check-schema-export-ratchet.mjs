#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const config = JSON.parse(
  await readFile(
    path.join(root, "tests/schema-export-fingerprint.json"),
    "utf8"
  )
);

async function schemaFiles(dir) {
  return (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

export async function schemaFingerprint(schemaDir) {
  const lines = await Promise.all(
    (await schemaFiles(schemaDir)).map(async (file) => {
      const digest = createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
      return `${digest}  packages/vault/src/schema/${path.basename(file)}\n`;
    })
  );
  return createHash("sha256").update(lines.join("")).digest("hex");
}

export function changedFiles(run = defaultGit) {
  return new Set(
    run(["diff", "--name-only", "origin/main", "--"])
      .split("\n")
      .map((file) => file.trim())
      .filter(Boolean)
  );
}

function defaultGit(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

if (process.argv[1] === import.meta.filename) {
  const current = await schemaFingerprint(
    path.join(root, "packages/vault/src/schema")
  );
  const changed = changedFiles();
  const schemaChanged = [...changed].some((file) =>
    file.startsWith("packages/vault/src/schema/")
  );
  if (current !== config.schemaFingerprint) {
    if (!schemaChanged || !changed.has(config.exportOwner)) {
      console.error(
        `schema/export ratchet: schema fingerprint changed (${current}); touch ${config.exportOwner} in the same PR and update tests/schema-export-fingerprint.json after auditing export completeness`
      );
      process.exit(1);
    }
    console.error(
      "schema/export ratchet: export owner changed with schema, but the committed fingerprint is stale"
    );
    process.exit(1);
  }
  console.log(`schema/export ratchet: ${current}`);
}
