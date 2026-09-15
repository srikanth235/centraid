/*
 * The e2e's data directory (#1020 wave 3 lane F).
 *
 * Builds a real vault with the real binary and lays out a blob that is **still
 * arriving** — a `.partial` prefix beside a declared `.total` — then appends the
 * rest on a timer while the test watches. That layout is not a test invention:
 * `crates/centraid/src/cmd/seat/blob.rs` documents it as how an in-flight
 * transfer looks on disk, and the sidecar's own integration test uses it too.
 *
 * The vault is founded by running `centraid gateway` until it prints its ready
 * line and then stopping it, rather than by writing SQL from Node: the schema
 * has triggers and foreign keys, and a fixture built by hand around them would
 * be a fixture the product could not have produced.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = import.meta.dirname;
export const REPO = path.resolve(HERE, "../..");

/** The `centraid` binary the test drives. */
export function centraidBinary() {
  const named = process.env.CENTRAID_BINARY;
  if (named) return named;
  const target = process.env.CARGO_TARGET_DIR ?? path.join(REPO, "target");
  return path.join(target, "debug", "centraid");
}

/** The committed fixture video and its recorded shape. */
export function videoFixture() {
  const dir = path.join(REPO, "contracts/desktop/fixtures");
  const meta = JSON.parse(
    fs.readFileSync(path.join(dir, "arriving.json"), "utf8")
  );
  const bytes = fs.readFileSync(path.join(dir, meta.file));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== meta.sha256) {
    throw new Error(
      `contracts/desktop/fixtures/${meta.file} does not match its recorded digest`
    );
  }
  if (bytes.length !== meta.byte_size) {
    throw new Error(
      `${meta.file} is ${bytes.length} bytes, not ${meta.byte_size}`
    );
  }
  return { ...meta, bytes, digest };
}

/** Found a vault under `dataDir` by running the real gateway briefly. */
export async function foundVault(dataDir) {
  const child = spawn(
    centraidBinary(),
    ["gateway", "--no-relay", "--data-dir", dataDir],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await new Promise((resolve, reject) => {
    let settled = false;
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(`the gateway did not found a vault: ${stderr.slice(-1000)}`)
      );
    }, 60_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled || !chunk.includes("gateway ready")) return;
      settled = true;
      clearTimeout(deadline);
      resolve();
    });
    child.on("exit", () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(new Error(`the gateway exited early: ${stderr.slice(-1000)}`));
    });
  });
  // SIGTERM and then wait: the gateway holds the vault's one writable
  // connection, and reading the file before it has closed would be reading a
  // vault whose WAL is still open.
  child.kill("SIGTERM");
  // Two promises, each resolved exactly once, raced: the exit, or the deadline
  // that escalates to SIGKILL. One promise with two resolve paths is the same
  // behaviour and a lint the repo is right to keep — a promise with two
  // resolvers is a promise whose second resolve is silently a no-op.
  await Promise.race([
    new Promise((resolve) => {
      child.once("exit", resolve);
    }),
    new Promise((resolve) => {
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5000);
    }),
  ]);
  const vaultRoot = path.join(dataDir, "vault");
  const vaultId = fs
    .readdirSync(vaultRoot)
    .find((name) => !name.startsWith("."));
  if (!vaultId) throw new Error("no vault was founded");
  return vaultId;
}

/**
 * Lay out a blob that is still arriving, and start the writer.
 *
 * `prefixRatio` of the bytes are there when the test starts; the rest land in
 * chunks after `startAfterMs`. Returns a handle whose `finished` resolves when
 * the last byte has landed, and whose `stop` kills the writer if the test ends
 * first.
 */
export function startArrivingBlob(
  dataDir,
  fixture,
  {
    prefixRatio = 0.2,
    startAfterMs = 300,
    // ~32 KiB/s. Slow ON PURPOSE: the seek test's precondition is that the
    // blob is still arriving when it seeks, so the fixture has to outlast the
    // test's own setup. Fast enough that the whole file lands inside one
    // Playwright timeout.
    chunkBytes = 8 * 1024,
    everyMs = 250,
  } = {}
) {
  const blobs = path.join(dataDir, "blobs");
  fs.mkdirSync(blobs, { recursive: true });
  const partial = path.join(blobs, `${fixture.digest}.partial`);
  const prefix = Math.max(1, Math.floor(fixture.bytes.length * prefixRatio));
  fs.writeFileSync(partial, fixture.bytes.subarray(0, prefix));
  fs.writeFileSync(
    path.join(blobs, `${fixture.digest}.total`),
    String(fixture.bytes.length)
  );
  fs.writeFileSync(
    path.join(blobs, `${fixture.digest}.type`),
    fixture.media_type
  );

  const complete = path.join(blobs, fixture.digest);
  // `finished` WATCHES THE FILE rather than being resolved by the writer: what
  // the test waits for is the state on disk the seat reads, so watching it is
  // the honest wait — and it keeps the resolver from escaping its executor,
  // which is a promise with two resolve paths waiting to happen.
  const finished = new Promise((resolve) => {
    const poll = setInterval(() => {
      if (!fs.existsSync(complete)) return;
      clearInterval(poll);
      resolve();
    }, 50);
  });

  let at = prefix;
  let timer;
  const tick = () => {
    if (at >= fixture.bytes.length) {
      // COMPLETE: rename the prefix to the blob's own name, which is exactly
      // what an iroh-blobs transfer does when the last byte verifies. The
      // sidecar then answers from the complete file and says `complete: true`.
      fs.renameSync(partial, complete);
      fs.rmSync(path.join(blobs, `${fixture.digest}.total`), { force: true });
      return;
    }
    const next = Math.min(at + chunkBytes, fixture.bytes.length);
    fs.appendFileSync(partial, fixture.bytes.subarray(at, next));
    at = next;
    timer = setTimeout(tick, everyMs);
  };
  const starter = setTimeout(tick, startAfterMs);
  return {
    partialPath: partial,
    prefixBytes: prefix,
    received: () =>
      fs.existsSync(partial) ? fs.statSync(partial).size : fixture.bytes.length,
    finished,
    stop: () => {
      // One call site, not two adjacent ones: oxlint's
      // `promise/no-multiple-resolved` reports two consecutive
      // `clearTimeout(...)` statements in this closure as a second resolve of
      // the promise above, which they are not. Recorded in the receipt as a
      // false positive in the rule; written this way rather than silenced,
      // because a disable comment would hide a real finding here later.
      for (const pending of [starter, timer]) {
        if (pending) clearTimeout(pending);
      }
    },
  };
}

/** A fresh data directory under the OS temp root. */
export function makeDataDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `centraid-e2e-${label}-`));
}
