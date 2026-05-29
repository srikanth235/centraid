// Export / import the apps repo to/from a remote (the issue's
// motivating use case: "back up my stuff" to the user's own GitHub).
//
// Export is `git push` of `main` + every `<app>/v<n>` tag from the
// bare repo to a remote URL. Import is `git clone --bare` of that
// remote into a fresh gateway root, after which `new AppsStore({
// root }).init()` materializes `main` and the runtime starts serving.
//
// Session branches (`sessions/<id>`) are deliberately NOT pushed —
// they're ephemeral local editing state, not something the user
// wants mirrored to GitHub. We push the explicit refspecs only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { run, runRaw } from './git.js';

export interface ExportOptions {
  /**
   * Remote name to (re)point at `remoteUrl`. Defaults to `origin`.
   * Re-running export updates the URL in place rather than failing
   * on an already-existing remote.
   */
  remoteName?: string;
  /** Force-push (`+`) the refs. Off by default — a rejected push surfaces. */
  force?: boolean;
}

export interface ExportResult {
  remoteName: string;
  remoteUrl: string;
  /** Refspecs pushed — `main` plus every app version tag. */
  pushed: string[];
}

/**
 * Push `main` + all `<app>/v<n>` tags from `bareDir` to `remoteUrl`.
 * Idempotent in the remote-setup step: the remote is created or
 * repointed as needed.
 */
export async function exportToRemote(
  bareDir: string,
  remoteUrl: string,
  opts: ExportOptions = {},
): Promise<ExportResult> {
  const remoteName = opts.remoteName ?? 'origin';

  // Create or repoint the remote. `remote add` fails if it exists,
  // so probe first and fall back to `set-url`.
  const existing = await runRaw(['remote', 'get-url', remoteName], {
    cwd: bareDir,
    allowNonZero: true,
  });
  if (existing.code === 0) {
    await run(['remote', 'set-url', remoteName, remoteUrl], { cwd: bareDir });
  } else {
    await run(['remote', 'add', remoteName, remoteUrl], { cwd: bareDir });
  }

  const lead = opts.force ? '+' : '';
  const mainSpec = `${lead}refs/heads/main:refs/heads/main`;
  // Push tags via the namespaced refspec so only app version tags
  // travel (and nothing else hiding under refs/tags).
  const tagSpec = `${lead}refs/tags/*:refs/tags/*`;
  await run(['push', remoteName, mainSpec, tagSpec], { cwd: bareDir });

  return { remoteName, remoteUrl, pushed: [mainSpec, tagSpec] };
}

export interface ImportResult {
  /** The gateway root that now contains `apps.git/`. */
  root: string;
  /** Absolute path to the cloned bare repo. */
  bareDir: string;
}

/**
 * Clone `remoteUrl` into `<root>/apps.git` as a bare repo. The
 * caller then constructs `new AppsStore({ root })` and calls
 * `init()` to materialize `main`. Refuses if `<root>/apps.git`
 * already exists — import is for a fresh gateway, not a merge.
 */
export async function importFromRemote(root: string, remoteUrl: string): Promise<ImportResult> {
  const bareDir = path.join(root, 'apps.git');
  if (await pathExists(bareDir)) {
    throw new Error(
      `Refusing to import: ${bareDir} already exists. Import targets a fresh gateway root.`,
    );
  }
  await fs.mkdir(root, { recursive: true });
  // `clone --bare` brings every branch + tag the remote advertises.
  // The default branch (main) becomes HEAD in the bare clone.
  await run(['clone', '--bare', remoteUrl, bareDir], { cwd: root });
  return { root, bareDir };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
