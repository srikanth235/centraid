import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

/**
 * The model manifest, and the ONE download path over it (#1011).
 *
 * Weights are release assets, not repository content: `models.lock.json` is
 * the manifest and every entry is pinned by sha256, byte length and an
 * immutable upstream URL (a commit-addressed HuggingFace `resolve/<sha>` or
 * GitHub `media/<sha>` link — never a moving `main`). `ensureModelAssets` is
 * what both the `setup` CLI and the gateway's first-boot fetch call, so
 * there is exactly one implementation of "is this file the file we pinned,
 * and if not, get it".
 */

export interface ModelLockFile {
  /** Model id and version, e.g. "yunet-arcface@1". */
  model: string;
  /** Path under `<runtimeDir>/models`, POSIX-separated. */
  path: string;
  sha256: string;
  /** Exact byte length of the pinned file. */
  bytes: number;
  license: string;
  url: string;
  /** Capabilities that cannot run without this file. */
  capabilities: readonly string[];
}

export interface ModelLock {
  schemaVersion: number;
  files: ModelLockFile[];
}

export interface EnsureModelAssetsOptions {
  /** The runtime directory; weights land under `<runtimeDir>/models`. */
  runtimeDir: string;
  /** Capability ids ("faces", "ocr", "embed-image", …). Anything outside
   *  this set is left completely alone — not read, not written. */
  capabilities: readonly string[];
  /**
   * The manifest to provision against. Defaults to this package's own
   * `models.lock.json`, which is what every real caller wants; a caller
   * that has already read the manifest passes it back rather than paying
   * for a second read, and tests drive a small synthetic one through the
   * exact same code.
   */
  lock?: ModelLock;
}

export interface EnsureModelAssetsResult {
  /** Capabilities whose every pinned file is present and digest-verified. */
  ready: string[];
  /** Paths (relative to `<runtimeDir>/models`) downloaded by THIS call. */
  fetched: string[];
  /** One entry per capability that could not be completed. */
  failed: { capability: string; error: string }[];
}

const LOCK_PATH = path.join(import.meta.dirname, "..", "models.lock.json");

let cachedLock: ModelLock | undefined;

/** Reads (and memoizes) the pinned manifest. */
export async function readModelLock(): Promise<ModelLock> {
  cachedLock ??= JSON.parse(await readFile(LOCK_PATH, "utf8")) as ModelLock;
  return cachedLock;
}

/** Every capability the manifest can satisfy, in manifest order. */
export function lockCapabilities(lock: ModelLock): string[] {
  const seen: string[] = [];
  for (const file of lock.files) {
    for (const capability of file.capabilities) {
      if (!seen.includes(capability)) seen.push(capability);
    }
  }
  return seen;
}

async function fileSha256(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

/** Present AND byte-identical to the pin. Size is checked first because it
 *  rules out a truncated or replaced file without hashing hundreds of MB. */
async function matchesPin(
  destination: string,
  file: ModelLockFile
): Promise<boolean> {
  try {
    const info = await stat(destination);
    if (!info.isFile() || info.size !== file.bytes) return false;
  } catch {
    return false;
  }
  return (await fileSha256(destination)) === file.sha256;
}

async function download(
  destination: string,
  file: ModelLockFile
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const response = await fetch(file.url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(
      `GET ${file.url} failed: ${response.status} ${response.statusText}`
    );
  }

  // Temp file + rename: a killed or corrupt download never leaves a partial
  // file where a complete one is expected, and a concurrent reader either
  // sees the old file or the new one, never a growing one.
  const temporary = `${destination}.partial`;
  try {
    await pipeline(
      Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
      createWriteStream(temporary)
    );
    const actual = await fileSha256(temporary);
    if (actual !== file.sha256) {
      throw new Error(
        `sha256 mismatch for ${file.path}: ${actual} != ${file.sha256}`
      );
    }
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * The same pin check as `ensureModelAssets`, with the download removed: every
 * requested capability is reported `ready` or `failed` purely from what is on
 * disk, and NO connection is ever opened (#1011). A host that has not been
 * configured to provision weights calls this instead, so an unconfigured
 * gateway — a test, an e2e harness, an embedded build — can never reach the
 * network by accident. `fetched` is always empty by construction.
 */
export async function verifyModelAssets(
  options: EnsureModelAssetsOptions
): Promise<EnsureModelAssetsResult> {
  const lock = options.lock ?? (await readModelLock());
  const modelsDir = path.join(options.runtimeDir, "models");
  const ready: string[] = [];
  const failed: { capability: string; error: string }[] = [];

  for (const capability of new Set(options.capabilities)) {
    const files = lock.files.filter((file) =>
      file.capabilities.includes(capability)
    );
    if (files.length === 0) {
      failed.push({
        capability,
        error: `no pinned assets for capability "${capability}"`,
      });
      continue;
    }
    const missing: string[] = [];
    for (const file of files) {
      // Sequential for the same reason the fetch path is: hashing hundreds of
      // megabytes in parallel is not a favour to a booting host.
      // oxlint-disable-next-line no-await-in-loop -- see comment above
      if (!(await matchesPin(path.join(modelsDir, file.path), file))) {
        missing.push(file.path);
      }
    }
    if (missing.length === 0) ready.push(capability);
    else
      failed.push({
        capability,
        error: `missing or unverified: ${missing.join(", ")}`,
      });
  }

  return { ready, fetched: [], failed };
}

/**
 * Makes the pinned weights for `capabilities` present under
 * `<runtimeDir>/models`, fetching only what is missing or fails its pin.
 * Idempotent and safe on every boot: a fully provisioned runtime does
 * `stat` + one hash per file and no network at all. A capability that
 * fails is reported, never thrown — the gateway boots either way and the
 * automation for that capability simply stays unavailable.
 */
export async function ensureModelAssets(
  options: EnsureModelAssetsOptions
): Promise<EnsureModelAssetsResult> {
  const lock = options.lock ?? (await readModelLock());
  const modelsDir = path.join(options.runtimeDir, "models");
  const requested = [...new Set(options.capabilities)];

  const ready: string[] = [];
  const fetched: string[] = [];
  const failed: { capability: string; error: string }[] = [];

  for (const capability of requested) {
    const files = lock.files.filter((file) =>
      file.capabilities.includes(capability)
    );
    if (files.length === 0) {
      failed.push({
        capability,
        error: `no pinned assets for capability "${capability}"`,
      });
      continue;
    }

    try {
      for (const file of files) {
        const destination = path.join(modelsDir, file.path);
        // Sequential on purpose: these are large, and a parallel fan-out
        // across an unprovisioned vault would open every model at once on a
        // first boot that is already competing with the rest of startup.
        // oxlint-disable-next-line no-await-in-loop -- see comment above
        if (await matchesPin(destination, file)) continue;
        // oxlint-disable-next-line no-await-in-loop -- see comment above
        await download(destination, file);
        fetched.push(file.path);
      }
      ready.push(capability);
    } catch (error) {
      failed.push({
        capability,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { ready, fetched, failed };
}
