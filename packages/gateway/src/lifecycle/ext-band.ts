// The ext band's lifecycle wiring (issue #286 phase 2) — the successor to
// the silo's draft-data seeding and migrations-on-publish. App data lives
// in the vault; what a draft session branches is the app's DECLARED
// extension tables:
//
//   - first draft access seeds the vault's `extdraft_<app>_*` band from the
//     live band (rows copied), then every access diff-applies the draft
//     manifest's `ext.tables` so a schema edit is previewable immediately
//     (rows preserved; reset is the explicit fresh-snapshot control);
//   - publish reads `ext.tables` from the POST-REBASE tree and applies the
//     DDL diff to the LIVE band transactionally (inside the store's publish
//     mutex, before the ff-merge — a refused spec aborts the publish), then
//     drops the draft band: the scratch copy is superseded.
//
// The composition root owns this: it is the one layer that sees both the
// session worktree (which carries `app.json`) and the vault plane.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ExtApplyOutcome, ExtTableSpec } from '@centraid/vault';
import type { WorktreeStore } from '../worktree-store/index.js';

/** The slice of the vault plane the lifecycle needs — injected, testable. */
export interface ExtBandOps {
  applyAppExt(appId: string, tables: ExtTableSpec[]): ExtApplyOutcome;
  seedAppExtDraft(
    appId: string,
    tables: ExtTableSpec[],
    opts?: { reset?: boolean },
  ): ExtApplyOutcome;
  dropAppExtDraft(appId: string): { dropped: string[] };
}

/**
 * The declared extension tables of the app.json at `appDir` — empty when
 * the manifest is missing, unreadable, or declares no `ext` block. Spec
 * validation is the vault's job at apply time; manifest-shape validation
 * is the publish path's (`validateManifestAt`).
 */
export async function readExtSpecs(appDir: string): Promise<ExtTableSpec[]> {
  try {
    const raw = await fs.readFile(path.join(appDir, 'app.json'), 'utf8');
    const parsed = JSON.parse(raw) as { ext?: { tables?: ExtTableSpec[] } };
    return Array.isArray(parsed.ext?.tables) ? parsed.ext.tables : [];
  } catch {
    return [];
  }
}

/**
 * The publish half: apply the post-rebase tree's declared specs to the
 * LIVE band (create/alter/drop, validated + receipted by the vault
 * gateway), then drop the superseded draft band. Wired as the store's
 * `beforeMerge` hook — a throw aborts the publish with `main` untouched.
 */
export async function applyExtOnPublish(
  ops: ExtBandOps,
  appId: string,
  worktreeAppDir: string,
): Promise<ExtApplyOutcome> {
  const specs = await readExtSpecs(worktreeAppDir);
  const outcome = ops.applyAppExt(appId, specs);
  ops.dropAppExtDraft(appId);
  return outcome;
}

/**
 * Build the runtime's draft code-dir resolver: resolve an app's code dir
 * to its OPEN session worktree and keep the vault's draft band in step
 * with the draft manifest before returning. Returns `undefined` for an
 * unknown/closed session (→ the runtime serves a 503), leaving the live
 * path unaffected. A refused spec propagates (→ 500 with the vault's
 * message) rather than masquerading as a missing session.
 */
export function makeDraftCodeDirResolver(
  store: WorktreeStore,
  ext?: ExtBandOps,
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

/**
 * Keep the draft band in step with the draft worktree's manifest. Cheap
 * when nothing changed (spec diff is a no-op); creates + seeds from live
 * on the very first access. Skipped entirely for apps that declare no ext
 * tables and have no draft band to maintain.
 */
export async function ensureDraftBand(
  ops: ExtBandOps,
  appId: string,
  worktreeAppDir: string,
): Promise<void> {
  const specs = await readExtSpecs(worktreeAppDir);
  if (specs.length === 0) {
    // Declaring zero tables in the draft still has to KILL a previously
    // declared draft table — seed handles the diff-to-empty.
    ops.dropAppExtDraft(appId);
    return;
  }
  ops.seedAppExtDraft(appId, specs);
}
