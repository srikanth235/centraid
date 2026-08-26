// Draft access seeds `extdraft_<app>_*` from live, then diffs the draft
// `ext.tables`. Publish applies the post-rebase specs to LIVE inside the
// publish mutex before the ff-merge, then drops the draft band (#286).

import { promises as fs } from "node:fs";
import path from "node:path";

import type { ExtApplyOutcome, ExtTableSpec } from "@centraid/vault";

import type { WorktreeStore } from "../worktree-store/index.js";

export interface ExtBandOps {
  applyAppExt: (appId: string, tables: ExtTableSpec[]) => ExtApplyOutcome;
  seedAppExtDraft: (
    appId: string,
    tables: ExtTableSpec[],
    opts?: { reset?: boolean }
  ) => ExtApplyOutcome;
  dropAppExtDraft: (appId: string) => { dropped: string[] };
}

export async function readExtSpecs(appDir: string): Promise<ExtTableSpec[]> {
  try {
    const raw = await fs.readFile(path.join(appDir, "app.json"), "utf8");
    const parsed = JSON.parse(raw) as { ext?: { tables?: ExtTableSpec[] } };
    return Array.isArray(parsed.ext?.tables) ? parsed.ext.tables : [];
  } catch {
    return [];
  }
}

export async function applyExtOnPublish(
  ops: ExtBandOps,
  appId: string,
  worktreeAppDir: string
): Promise<ExtApplyOutcome> {
  const specs = await readExtSpecs(worktreeAppDir);
  const outcome = ops.applyAppExt(appId, specs);
  ops.dropAppExtDraft(appId);
  return outcome;
}

/** Closed session → `undefined` (503). A refused spec must propagate, not look missing. */
export function makeDraftCodeDirResolver(
  store: WorktreeStore,
  ext?: ExtBandOps
): (appId: string, sessionId: string) => Promise<string | undefined> {
  return async (appId, sessionId) => {
    let worktreeAppDir: string;
    try {
      worktreeAppDir = await store.snapshotSessionAppDir(sessionId, appId);
    } catch {
      return undefined;
    }
    if (ext) await ensureDraftBand(ext, appId, worktreeAppDir);
    return worktreeAppDir;
  };
}

export async function ensureDraftBand(
  ops: ExtBandOps,
  appId: string,
  worktreeAppDir: string
): Promise<void> {
  const specs = await readExtSpecs(worktreeAppDir);
  if (specs.length === 0) {
    // Zero tables still has to drop a previously declared draft table.
    ops.dropAppExtDraft(appId);
    return;
  }
  ops.seedAppExtDraft(appId, specs);
}
