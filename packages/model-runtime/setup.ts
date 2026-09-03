#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { MODELS_DIR, RUNTIME_DIR } from "./src/config.js";

interface DownloadSpec {
  url: string;
  destination: string;
  sha256: string;
  /** Short "Name — SPDX-License-Identifier (source)" line, printed in the summary and matching LICENSES.md. */
  licence: string;
}

interface ModelLock {
  files: Array<{
    model: string;
    path: string;
    sha256: string;
    license: string;
    url: string;
  }>;
}

const lock = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "models.lock.json"), "utf8")
) as ModelLock;
const DOWNLOADS: DownloadSpec[] = lock.files.map((file) => ({
  url: file.url,
  destination: path.join(MODELS_DIR, file.path),
  sha256: file.sha256,
  licence: `${file.model} — ${file.license}`,
}));

async function fileSha256(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

async function downloadFile(
  spec: DownloadSpec
): Promise<"downloaded" | "already present"> {
  if (existsSync(spec.destination)) {
    const actual = await fileSha256(spec.destination);
    if (actual !== spec.sha256) {
      throw new Error(
        `SHA-256 mismatch for cached ${spec.destination}: ${actual} != ${spec.sha256}`
      );
    }
    return "already present";
  }
  mkdirSync(path.dirname(spec.destination), { recursive: true });

  const response = await fetch(spec.url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(
      `GET ${spec.url} failed: ${response.status} ${response.statusText}`
    );
  }

  const tempPath = `${spec.destination}.partial`;
  await pipeline(
    Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
    createWriteStream(tempPath)
  );
  renameSync(tempPath, spec.destination);
  const actual = await fileSha256(spec.destination);
  if (actual !== spec.sha256) {
    throw new Error(
      `SHA-256 mismatch for downloaded ${spec.destination}: ${actual} != ${spec.sha256}`
    );
  }
  return "downloaded";
}

function installRuntimeDependencies(): void {
  console.log(
    `Running "bun install" in ${RUNTIME_DIR} (installs optional local recognition runtimes)...`
  );
  const result = spawnSync("bun", ["install"], {
    cwd: RUNTIME_DIR,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `"bun install" in ${RUNTIME_DIR} exited with status ${result.status ?? "unknown"}`
    );
  }
}

async function main(): Promise<void> {
  mkdirSync(MODELS_DIR, { recursive: true });

  installRuntimeDependencies();

  console.log("\nFetching model weights + auxiliary files...");
  const fetched: string[] = [];
  for (const spec of DOWNLOADS) {
    // oxlint-disable-next-line no-await-in-loop -- see comment above
    const outcome = await downloadFile(spec);
    console.log(
      `  [${outcome === "downloaded" ? "downloaded" : "cached"}] ${path.relative(RUNTIME_DIR, spec.destination)}`
    );
    fetched.push(spec.destination);
  }

  console.log("\nLicences (also recorded in LICENSES.md):");
  const uniqueLicences = [...new Set(DOWNLOADS.map((d) => d.licence))];
  for (const licence of uniqueLicences) {
    console.log(`  - ${licence}`);
  }

  console.log(
    `\nDone. ${fetched.length} files present under ${MODELS_DIR}. Recognition automations load them directly.`
  );
}

await main();
