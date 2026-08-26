/*
 * One vault's `SourceEntry[]` for `createSnapshot` (FORMAT.md). Long-lived keys
 * never enter a snapshot, and remote-CAS config is not durability evidence.
 */

import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import { WAL_DB_FILES } from "@centraid/backup";
import type { EngineLogger, SourceEntry } from "@centraid/backup";
import {
  archivedSegmentShas,
  conversationArchiveShas,
  liveBlobShasCached,
  readBlobStoreSettings,
  ReplicaIndex,
} from "@centraid/vault";

import type { VaultPlane } from "../serve/vault-plane.js";
import { GitError, run } from "../worktree-store/git.js";

async function listBlobEntries(
  vaultDir: string,
  only?: ReadonlySet<string>
): Promise<SourceEntry[]> {
  const base = path.join(vaultDir, "blobs", "sha256");
  if (!existsSync(base)) return [];
  const entries = (
    await Promise.all(
      (
        await fs.readdir(base)
      ).map(async (fan) => {
        const fanDir = path.join(base, fan);
        try {
          const names = await fs.readdir(fanDir);
          return names
            .filter(
              (name) =>
                /^[0-9a-f]{64}$/u.test(name) && (!only || only.has(name))
            )
            .map((name) => ({
              path: `blobs/sha256/${fan}/${name}`,
              kind: "blob" as const,
              absolutePath: path.join(fanDir, name),
            }));
        } catch {
          return [];
        }
      })
    )
  ).flat();
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

async function codeRefsDigest(bareDir: string): Promise<string> {
  const refs = await run(
    ["for-each-ref", "--format=%(objectname) %(refname)"],
    { cwd: bareDir }
  );
  const head = await run(["symbolic-ref", "--quiet", "HEAD"], {
    cwd: bareDir,
  }).catch(() => "");
  return createHash("sha256").update(`${head}\n${refs}`).digest("hex");
}

/** Gated on `codeRefsDigest`: an unchanged store leaves the bundle UNTOUCHED
 *  so the upload path's `(size, mtime)` fast path reuses its chunks. */
async function bundleCodeStore(
  plane: VaultPlane,
  bundleDir: string,
  log: EngineLogger
): Promise<SourceEntry | undefined> {
  const bareDir = path.join(plane.codeStoreRoot, "apps.git");
  if (!existsSync(path.join(bareDir, "HEAD"))) {
    log.info?.(
      "backup: no code store bare repo yet — skipping git-bundle entry"
    );
    return undefined;
  }
  await fs.mkdir(bundleDir, { recursive: true });
  const bundlePath = path.join(bundleDir, "apps.bundle");
  const digestPath = path.join(bundleDir, "apps.bundle.refs");
  const digest = await codeRefsDigest(bareDir);

  if (existsSync(bundlePath)) {
    const priorDigest = await fs.readFile(digestPath, "utf8").catch(() => "");
    if (priorDigest === digest) {
      log.info?.(
        "backup: code store unchanged since last snapshot — reusing apps.bundle"
      );
      return {
        path: "apps.bundle",
        kind: "git-bundle",
        absolutePath: bundlePath,
      };
    }
  }

  try {
    // `pack.threads=1` is byte-deterministic, so unchanged history dedups.
    await run(
      ["-c", "pack.threads=1", "bundle", "create", bundlePath, "--all"],
      { cwd: bareDir }
    );
    await fs.writeFile(digestPath, digest);
    return {
      path: "apps.bundle",
      kind: "git-bundle",
      absolutePath: bundlePath,
    };
  } catch (error) {
    const message = error instanceof GitError ? error.message : String(error);
    log.warn?.(
      `backup: git bundle create failed (skipping git-bundle entry): ${message}`
    );
    return undefined;
  }
}

export interface AssembleOptions {
  plane: VaultPlane;
  bundleDir: string;
  walTipTickMs?: number;
  log: EngineLogger;
}

export async function assembleSourceEntries(
  opts: AssembleOptions
): Promise<SourceEntry[]> {
  const { plane, bundleDir, log } = opts;
  const entries: SourceEntry[] = [];

  const shipper = plane.walShipper;
  if (!shipper) {
    throw new Error(
      "backup: vault has no WAL shipper (in-memory vault?) — nothing to snapshot"
    );
  }
  const bases = shipper.currentBases();
  if (bases.length < 2) {
    throw new Error(
      `backup: only ${bases.length}/2 database base(s) are pinned (busy checkpoint on first run?) — retrying later instead of registering a partial snapshot`
    );
  }
  // The two bases MUST be from ONE tick: a busy checkpoint can defer the
  // coordinated break, and a mixed pair has no coordinated restore point — the
  // newer base holds receipts for rows living only in the older one's SEGMENTS.
  if (bases[0]!.createdAtMs !== bases[1]!.createdAtMs) {
    throw new Error(
      `backup: the two database bases are from different ticks (` +
        bases.map((b) => `${b.db} @ ${b.createdAtMs}`).join(", ") +
        ") — a coordinated generation break is still pending; retrying later instead of " +
        "registering an uncoordinated base pair"
    );
  }
  for (const base of bases) {
    entries.push({
      path: WAL_DB_FILES[base.db],
      kind: "db",
      absolutePath: base.file,
      sha256: base.sha256,
      walGeneration: base.generation,
      baseTickMs: base.createdAtMs,
      // A floor: without it a deleted `wal/tick/` prefix is silent.
      ...(opts.walTipTickMs === undefined
        ? {}
        : { walTipTickMs: opts.walTipTickMs }),
    });
  }

  // Remote-primary snapshots only bytes lacking replica evidence.
  const remotePrimary = readBlobStoreSettings(plane.db.vault).kind === "s3";
  let pending: Set<string> | undefined;
  if (remotePrimary) {
    pending = new Set(plane.db.blobTransfers.pendingSnapshotShas());
    const replicated = new ReplicaIndex(plane.db.vault).all();
    for (const sha of liveBlobShasCached(plane.db.vault))
      if (!replicated.has(sha)) pending.add(sha);
    for (const sha of archivedSegmentShas(plane.db.journal))
      if (!replicated.has(sha)) pending.add(sha);
    for (const sha of conversationArchiveShas(plane.db.journal))
      if (!replicated.has(sha)) pending.add(sha);
  }
  entries.push(...(await listBlobEntries(plane.dir, pending)));

  const bundle = await bundleCodeStore(plane, bundleDir, log);
  if (bundle) entries.push(bundle);

  return entries;
}
