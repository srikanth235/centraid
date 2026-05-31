// governance: allow-repo-hygiene file-size-limit publish/rollback/delete critical sections share private state — keeping them in one file preserves the per-store mutex invariant
// Gateway-owned git store for centraid app code. Full design in
// receipt #137; this header sketches the layout + invariants.
//
// Layout: `apps.git/` (bare repo, pushed to GitHub),
// `worktrees/main/<sha>/` (read-only materialization, swapped on
// publish), `worktrees/sessions/<id>/` (mutable per-session editing).
//
// Refs: `main` (trunk), `sessions/<id>` (ephemeral), tag
// `<appId>/v<n>` (immutable forward marker, monotonic per app).
//
// Sessions branch off main; publish ff-merges back + tags; rollback
// is a *new* forward commit overlaying an older subtree — never a
// reset, so `git log main` stays the audit of everything live.
//
// A single AppsStore serializes publish + rollback through one
// per-store mutex. Each publish materializes a fresh
// `worktrees/main/<sha>/`, flips an in-memory pointer, then removes
// the previous dir — fresh-path-per-publish rotates require() cache
// lines naturally (the runtime keys its handler cache on path).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { run, runRaw, revParse } from './git.js';
import {
  AppsStoreError,
  type AppsStoreOptions,
  type PublishInput,
  type PublishResult,
  type RollbackInput,
  type RollbackResult,
  type SessionHandle,
  type VersionEntry,
} from './types.js';

/** Git's canonical empty tree sha. Used to plant the initial main commit. */
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Conservative slug check — matches the canonical app id rule
 * (agent-harness): leading alnum, then alnum / `_` / `-`. No dot, so a
 * tree-traversing `..` is impossible by construction. Automation apps are
 * now marked by the manifest's `kind` field, not a dotted `auto.` id
 * prefix, so the id grammar is a plain slug again.
 */
const SAFE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/** Stable symlink name (under the store root) pointing at the live main worktree. */
const ACTIVE_MAIN_LINK = 'active-main';

export class AppsStore {
  private readonly root: string;
  private readonly bareDir: string;
  private readonly worktreesDir: string;
  private readonly mainWorktreesDir: string;
  private readonly sessionWorktreesDir: string;
  private readonly activeMainLink: string;
  private activeMainDir: string | undefined;
  private publishChain: Promise<unknown> = Promise.resolve();
  private initialized = false;

  constructor(options: AppsStoreOptions) {
    this.root = options.root;
    this.bareDir = path.join(options.root, 'apps.git');
    this.worktreesDir = path.join(options.root, 'worktrees');
    this.mainWorktreesDir = path.join(this.worktreesDir, 'main');
    this.sessionWorktreesDir = path.join(this.worktreesDir, 'sessions');
    this.activeMainLink = path.join(options.root, ACTIVE_MAIN_LINK);
  }

  /**
   * Bootstrap the store. Idempotent: mkdir → `git init --bare` (skip
   * if HEAD present) → plant empty initial `main` if ref missing →
   * `worktree prune` stale entries → materialize `worktrees/main/<sha>/`
   * → cache `activeMainDir`. Re-runs reuse everything.
   */
  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await fs.mkdir(this.worktreesDir, { recursive: true });
    await fs.mkdir(this.mainWorktreesDir, { recursive: true });
    await fs.mkdir(this.sessionWorktreesDir, { recursive: true });

    if (!(await pathExists(path.join(this.bareDir, 'HEAD')))) {
      await fs.mkdir(this.bareDir, { recursive: true });
      // `-b main` pins HEAD; without it the host's `init.defaultBranch`
      // (often `master`) wins and downstream calls chase a dynamic name.
      await run(['init', '--bare', '-b', 'main', this.bareDir], { cwd: this.root });
    }

    if (!(await revParse(this.bareDir, 'refs/heads/main'))) {
      // Empty initial commit so sessions have something to branch off.
      // `commit-tree` against git's canonical empty-tree sha — no
      // working tree needed.
      const initialSha = await run(
        ['commit-tree', EMPTY_TREE_SHA, '-m', 'centraid: init apps repo'],
        { cwd: this.bareDir },
      );
      await run(['update-ref', 'refs/heads/main', initialSha], { cwd: this.bareDir });
    }

    // Drop worktree metadata pointing at vanished dirs (e.g. host crash).
    await run(['worktree', 'prune'], { cwd: this.bareDir });
    const mainSha = (await revParse(this.bareDir, 'refs/heads/main')) ?? '';
    this.activeMainDir = await this.ensureMainMaterialization(mainSha);
    await this.updateActiveMainLink(this.activeMainDir);
    this.initialized = true;
  }

  /** Active main worktree path; runtime reads handlers from `<this>/apps/<id>/`. */
  getActiveMainDir(): string | undefined {
    return this.activeMainDir;
  }

  /**
   * Stable path to the `active-main` symlink (`<root>/active-main`),
   * repointed atomically at the live main worktree on every publish /
   * rollback / delete. Unlike `getActiveMainDir()` — which rotates per
   * sha — this path never changes, so external processes that must bake
   * a path once (the OS scheduler's `centraid run-automation`, which
   * resolves automation code under `<this>/apps/<id>/`) stay correct
   * across version swaps. The symlink exists after `init()`.
   */
  getActiveMainLink(): string {
    return this.activeMainLink;
  }

  /** Bare repo path — for export/import + tests. */
  get bareRepoDir(): string {
    return this.bareDir;
  }

  /** Every app id with an `apps/<id>/` subtree on main. Replaces `_registry.json`. */
  async listApps(): Promise<string[]> {
    this.assertInitialized();
    const out = await runRaw(['ls-tree', '--name-only', 'refs/heads/main:apps'], {
      cwd: this.bareDir,
      allowNonZero: true,
    });
    if (out.code !== 0) return []; // no `apps/` dir yet
    return out.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && SAFE_ID_RE.test(line))
      .sort();
  }

  /**
   * App ids on main plus their `app.json` metadata + `hasIndex` flag,
   * read from the materialized-main worktree. Replaces the desktop's
   * legacy `listProjects(workspaceDir)` scan.
   */
  async listAppsWithMeta(): Promise<
    Array<{
      id: string;
      name?: string;
      description?: string;
      kind?: 'app' | 'automation';
      hasIndex: boolean;
    }>
  > {
    this.assertInitialized();
    const ids = await this.listApps();
    const mainDir = this.activeMainDir;
    if (!mainDir || ids.length === 0) return [];
    const rows = await Promise.all(
      ids.map(async (id) => {
        const appDir = path.join(mainDir, 'apps', id);
        const manifest: Record<string, unknown> = await readJson(
          path.join(appDir, 'app.json'),
        ).catch(() => ({}));
        const hasIndex = await pathExists(path.join(appDir, 'index.html'));
        return {
          id,
          ...(typeof manifest.name === 'string' ? { name: manifest.name } : {}),
          ...(typeof manifest.description === 'string'
            ? { description: manifest.description }
            : {}),
          ...(manifest.kind === 'automation' || manifest.kind === 'app'
            ? { kind: manifest.kind as 'app' | 'automation' }
            : {}),
          hasIndex,
        };
      }),
    );
    return rows;
  }

  /**
   * Remove an app from `main` entirely — path-scoped `git rm -r
   * apps/<appId>` on a detached worktree, commit on main, atomic
   * `<appId>/v*` tag cleanup, materialize. Forward-only like publish;
   * the deletion appears as a fresh commit so `git log main` keeps
   * the audit. Serialized through the same publish mutex.
   *
   * Throws `no_changes` when the app wasn't on main.
   */
  deleteApp(appId: string): Promise<{ sha: string; materializedMainDir: string }> {
    return this.serialize(() => this.deleteAppCritical(appId));
  }

  /** App's active code dir, or undefined when never published. */
  async resolveActiveAppDir(appId: string): Promise<string | undefined> {
    assertSafeId(appId, 'invalid_app_id');
    this.assertInitialized();
    const mainDir = this.activeMainDir;
    if (!mainDir) return undefined;
    const appDir = path.join(mainDir, 'apps', appId);
    return (await pathExists(appDir)) ? appDir : undefined;
  }

  /**
   * Absolute path to `<sessionDir>/apps/<appId>/`, mkdir'd if missing.
   * Refuses with `session_missing` when the session worktree isn't
   * registered (no `.git` link file). Without this guard a stray
   * `PUT files` could materialize `worktrees/sessions/<id>/apps/<app>/`
   * from a typo'd id; `openSession(id)` would then 409 with
   * `session_exists` and a later `publish()` would `git add` in a
   * plain dir and fail.
   */
  async snapshotSessionAppDir(sessionId: string, appId: string): Promise<string> {
    assertSafeId(sessionId, 'invalid_session_id');
    assertSafeId(appId, 'invalid_app_id');
    this.assertInitialized();
    const worktreeRoot = this.sessionWorktreePath(sessionId);
    if (!(await pathExists(path.join(worktreeRoot, '.git')))) {
      throw new AppsStoreError(
        'session_missing',
        `Session "${sessionId}" has no worktree — open it first via openSession().`,
      );
    }
    const dir = path.join(worktreeRoot, 'apps', appId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /** Branch `sessions/<id>` off `main` + materialize a mutable worktree the agent edits. */
  async openSession(sessionId: string): Promise<SessionHandle> {
    assertSafeId(sessionId, 'invalid_session_id');
    this.assertInitialized();
    const worktreePath = this.sessionWorktreePath(sessionId);
    if (await pathExists(worktreePath)) {
      throw new AppsStoreError(
        'session_exists',
        `Session "${sessionId}" already has a worktree at ${worktreePath}.`,
      );
    }
    const branch = sessionBranchName(sessionId);
    await run(['worktree', 'add', '-b', branch, worktreePath, 'refs/heads/main'], {
      cwd: this.bareDir,
    });
    return { id: sessionId, branch, worktreePath };
  }

  /** Remove a session's worktree + branch. Idempotent (safe on a vanished session). */
  async closeSession(sessionId: string): Promise<void> {
    assertSafeId(sessionId, 'invalid_session_id');
    this.assertInitialized();
    const worktreePath = this.sessionWorktreePath(sessionId);
    if (await pathExists(worktreePath)) {
      // `--force` tolerates uncommitted edits (the session is
      // being abandoned by design).
      await runRaw(['worktree', 'remove', '--force', worktreePath], {
        cwd: this.bareDir,
        allowNonZero: true,
      });
    }
    // Prune so the metadata catches up with any directory we just
    // removed (or that vanished beforehand).
    await run(['worktree', 'prune'], { cwd: this.bareDir });
    const branch = sessionBranchName(sessionId);
    await runRaw(['branch', '-D', branch], { cwd: this.bareDir, allowNonZero: true });
  }

  /**
   * Return the ids of every active session — every branch under
   * `refs/heads/sessions/` whose worktree is still registered. The
   * gateway calls this on bootstrap to reattach to in-flight
   * sessions (and prune orphans).
   */
  async listSessions(): Promise<string[]> {
    this.assertInitialized();
    const out = await run(['for-each-ref', '--format=%(refname:short)', 'refs/heads/sessions/'], {
      cwd: this.bareDir,
    });
    if (!out) return [];
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('sessions/'))
      .map((line) => line.slice('sessions/'.length));
  }

  /**
   * Publish an app from a session: path-scoped commit, immutable
   * tag `<appId>/v<n>`, ff-merge into `main` (rebase if `main`
   * advanced under the session), materialize the new main worktree,
   * swap the active pointer, evict the old materialization.
   *
   * Serialized through a per-store mutex so two parallel publishes
   * — even of different apps — can't race on `main`.
   */
  publish(input: PublishInput): Promise<PublishResult> {
    return this.serialize(() => this.publishCritical(input));
  }

  /**
   * Forward-only rollback: overlay `<appId>'s` subtree from
   * `<versionTag>` onto current `main` as a *new* commit (NOT
   * tagged). `git log main` therefore stays a chronological audit
   * including rollbacks; tag-version numbers stay monotonic.
   *
   * Also serialized through the per-store mutex.
   */
  rollback(input: RollbackInput): Promise<RollbackResult> {
    return this.serialize(() => this.rollbackCritical(input));
  }

  /**
   * Versions of an app, newest-first. Walks `refs/tags/<appId>/v*`,
   * pairs each with its tagged commit's sha + committer date, and
   * marks the entry whose `apps/<appId>/` subtree matches main's as
   * `active`. Forward publish → newest tag is active. Rollback
   * overlay → the older tag re-laid on main becomes active again.
   */
  async listVersions(appId: string): Promise<VersionEntry[]> {
    assertSafeId(appId, 'invalid_app_id');
    this.assertInitialized();
    const out = await run(
      [
        'for-each-ref',
        '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)',
        `refs/tags/${appId}/v*`,
      ],
      { cwd: this.bareDir },
    );
    if (!out) return [];
    const mainAppTree = await this.treeSha(`refs/heads/main:apps/${appId}`);
    const rows: VersionEntry[] = [];
    for (const line of out.split('\n')) {
      const [tag, sha, uploadedAt] = line.split('\t');
      if (!tag || !sha || !uploadedAt) continue;
      const m = /\/v(\d+)$/.exec(tag);
      if (!m) continue;
      const version = Number.parseInt(m[1] ?? '', 10);
      if (!Number.isFinite(version)) continue;
      const tagAppTree = await this.treeSha(`${tag}:apps/${appId}`);
      const active = mainAppTree !== undefined && tagAppTree === mainAppTree;
      rows.push({ tag, version, sha, uploadedAt, active });
    }
    rows.sort((a, b) => b.version - a.version);
    return rows;
  }

  /** Resolve `<ref>:<path>` to its tree/blob sha, or undefined if absent. */
  private async treeSha(refPath: string): Promise<string | undefined> {
    const r = await runRaw(['rev-parse', refPath], {
      cwd: this.bareDir,
      allowNonZero: true,
    });
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  // ── internals ────────────────────────────────────────────────────

  private async publishCritical(input: PublishInput): Promise<PublishResult> {
    const { sessionId, appId, message } = input;
    assertSafeId(sessionId, 'invalid_session_id');
    assertSafeId(appId, 'invalid_app_id');
    this.assertInitialized();

    const sessionDir = this.sessionWorktreePath(sessionId);
    if (!(await pathExists(sessionDir))) {
      throw new AppsStoreError(
        'session_missing',
        `Session "${sessionId}" has no worktree — call openSession() first.`,
      );
    }

    // Stage only the per-app subtree so cross-app edits in the same
    // session don't ride along (the issue's path-scoped-commit
    // contract).
    const appSubdir = `apps/${appId}`;
    await fs.mkdir(path.join(sessionDir, appSubdir), { recursive: true });
    await run(['add', '--', appSubdir], { cwd: sessionDir });

    const diff = await runRaw(['diff', '--cached', '--quiet', '--', appSubdir], {
      cwd: sessionDir,
      allowNonZero: true,
    });
    if (diff.code === 0) {
      throw new AppsStoreError(
        'no_changes',
        `Session "${sessionId}" has no staged changes under ${appSubdir}.`,
      );
    }

    const subject = `${appId}: ${message}`;
    await run(['commit', '-m', subject], { cwd: sessionDir });

    // Rebase if main advanced under us. Inside the publish mutex,
    // the only writer that can have advanced main is a publish that
    // completed before us — `merge-base` is the exact "did we
    // diverge" probe.
    const mainBeforeSha = (await revParse(this.bareDir, 'refs/heads/main')) ?? '';
    const sessionBranch = sessionBranchName(sessionId);
    const mergeBase = await run(['merge-base', 'refs/heads/main', sessionBranch], {
      cwd: this.bareDir,
    });
    if (mergeBase !== mainBeforeSha) {
      // Replay the session's commits on top of current main. We do
      // the rebase in the session worktree (it has the index + HEAD
      // git needs for a normal rebase).
      await run(['rebase', 'refs/heads/main'], { cwd: sessionDir });
    }

    const sessionTipSha = await run(['rev-parse', 'HEAD'], { cwd: sessionDir });

    // Pick the next version number BEFORE writing the tag so a
    // concurrent caller — though serialized through publishChain on
    // this store, a fresh AppsStore on the same disk would still
    // honor existing tags — never collides.
    const nextN = await this.nextVersionNumber(appId);
    const tag = `${appId}/v${nextN}`;
    await run(['tag', tag, sessionTipSha], { cwd: this.bareDir });

    // Fast-forward main. After the rebase above main is guaranteed
    // an ancestor of session-tip, so a direct ref update is safe.
    await run(['update-ref', 'refs/heads/main', sessionTipSha, mainBeforeSha], {
      cwd: this.bareDir,
    });

    const newMainDir = await this.ensureMainMaterialization(sessionTipSha);
    await this.swapActiveMain(newMainDir);

    return { versionTag: tag, sha: sessionTipSha, materializedMainDir: newMainDir };
  }

  private async rollbackCritical(input: RollbackInput): Promise<RollbackResult> {
    const { appId, versionTag } = input;
    assertSafeId(appId, 'invalid_app_id');
    this.assertInitialized();

    if (!(await revParse(this.bareDir, `refs/tags/${versionTag}`))) {
      throw new AppsStoreError(
        'tag_missing',
        `Tag "${versionTag}" does not exist in the apps repo.`,
      );
    }

    // Transient worktree off main for the overlay commit. Same
    // reason as openSession — bare repos can't `checkout` directly.
    const txId = `_rollback-${crypto.randomBytes(6).toString('hex')}`;
    const txDir = path.join(this.worktreesDir, txId);
    await run(['worktree', 'add', '--detach', txDir, 'refs/heads/main'], {
      cwd: this.bareDir,
    });
    try {
      const appSubdir = `apps/${appId}`;
      await run(['checkout', `refs/tags/${versionTag}`, '--', appSubdir], { cwd: txDir });
      await run(['add', '--', appSubdir], { cwd: txDir });
      const diff = await runRaw(['diff', '--cached', '--quiet', '--', appSubdir], {
        cwd: txDir,
        allowNonZero: true,
      });
      if (diff.code === 0) {
        throw new AppsStoreError(
          'no_changes',
          `Rollback to ${versionTag} would produce no change — current main already matches.`,
        );
      }
      const subject = `rollback: ${appId} -> ${versionTag}`;
      await run(['commit', '-m', subject], { cwd: txDir });
      const newSha = await run(['rev-parse', 'HEAD'], { cwd: txDir });
      const oldMainSha = (await revParse(this.bareDir, 'refs/heads/main')) ?? '';
      await run(['update-ref', 'refs/heads/main', newSha, oldMainSha], { cwd: this.bareDir });
      const newMainDir = await this.ensureMainMaterialization(newSha);
      await this.swapActiveMain(newMainDir);
      return { sha: newSha, materializedMainDir: newMainDir };
    } finally {
      await runRaw(['worktree', 'remove', '--force', txDir], {
        cwd: this.bareDir,
        allowNonZero: true,
      });
      await run(['worktree', 'prune'], { cwd: this.bareDir });
    }
  }

  private async deleteAppCritical(
    appId: string,
  ): Promise<{ sha: string; materializedMainDir: string }> {
    assertSafeId(appId, 'invalid_app_id');
    this.assertInitialized();

    const txId = `_delete-${crypto.randomBytes(6).toString('hex')}`;
    const txDir = path.join(this.worktreesDir, txId);
    await run(['worktree', 'add', '--detach', txDir, 'refs/heads/main'], {
      cwd: this.bareDir,
    });
    try {
      const appSubdir = `apps/${appId}`;
      const rm = await runRaw(['rm', '-r', '--ignore-unmatch', '--', appSubdir], {
        cwd: txDir,
        allowNonZero: true,
      });
      if (rm.code !== 0) {
        throw new AppsStoreError('no_changes', `App "${appId}" not on main — nothing to delete.`);
      }
      const diff = await runRaw(['diff', '--cached', '--quiet', '--', appSubdir], {
        cwd: txDir,
        allowNonZero: true,
      });
      if (diff.code === 0) {
        throw new AppsStoreError('no_changes', `App "${appId}" not on main — nothing to delete.`);
      }
      await run(['commit', '-m', `delete: ${appId}`], { cwd: txDir });
      const newSha = await run(['rev-parse', 'HEAD'], { cwd: txDir });
      const oldMainSha = (await revParse(this.bareDir, 'refs/heads/main')) ?? '';
      await run(['update-ref', 'refs/heads/main', newSha, oldMainSha], { cwd: this.bareDir });
      // Drop the app's version tags too — listVersions(appId) should
      // return [] post-delete. Best-effort per tag.
      const versions = await this.listVersions(appId);
      for (const v of versions) {
        await runRaw(['tag', '-d', v.tag], { cwd: this.bareDir, allowNonZero: true });
      }
      const newMainDir = await this.ensureMainMaterialization(newSha);
      await this.swapActiveMain(newMainDir);
      return { sha: newSha, materializedMainDir: newMainDir };
    } finally {
      await runRaw(['worktree', 'remove', '--force', txDir], {
        cwd: this.bareDir,
        allowNonZero: true,
      });
      await run(['worktree', 'prune'], { cwd: this.bareDir });
    }
  }

  /**
   * Compute `<n>` for the next `<appId>/v<n>` tag — one greater
   * than the highest existing version, starting at 1.
   */
  private async nextVersionNumber(appId: string): Promise<number> {
    const versions = await this.listVersions(appId);
    if (versions.length === 0) return 1;
    const highest = versions[0]?.version ?? 0;
    return highest + 1;
  }

  /**
   * Materialize `worktrees/main/<sha>/` if it isn't already on disk
   * + registered as a worktree. Idempotent so init can call it
   * unconditionally on bootstrap.
   */
  private async ensureMainMaterialization(sha: string): Promise<string> {
    const dir = path.join(this.mainWorktreesDir, sha);
    if (await pathExists(dir)) {
      // If the directory exists but git doesn't remember it as a
      // worktree (e.g. host crash), `git worktree prune` cleaned the
      // metadata and re-adding would refuse on a non-empty path.
      // Trust the on-disk tree in that case.
      return dir;
    }
    await run(['worktree', 'add', '--detach', dir, sha], { cwd: this.bareDir });
    return dir;
  }

  /**
   * Flip the active-main pointer to `newDir`, repoint the stable
   * `active-main` symlink, then evict the prior materialization. The
   * symlink is repointed BEFORE the old dir is removed so a reader
   * resolving the stable path never observes a dangling link. The
   * eviction is synchronous in v0; refcount / drain semantics belong
   * in the runtime-wiring slice.
   */
  private async swapActiveMain(newDir: string): Promise<void> {
    const previous = this.activeMainDir;
    this.activeMainDir = newDir;
    await this.updateActiveMainLink(newDir);
    if (previous && previous !== newDir) {
      await runRaw(['worktree', 'remove', '--force', previous], {
        cwd: this.bareDir,
        allowNonZero: true,
      });
      await run(['worktree', 'prune'], { cwd: this.bareDir });
      await fs.rm(previous, { recursive: true, force: true });
    }
  }

  /**
   * Atomically point `<root>/active-main` at `targetDir`. The target is
   * stored relative to the store root so the whole store can be moved
   * wholesale (export/import) without breaking the link. Replacement is
   * via write-temp-then-rename so concurrent readers see either the old
   * or the new target, never a half-written link.
   */
  private async updateActiveMainLink(targetDir: string): Promise<void> {
    const rel = path.relative(this.root, targetDir);
    const tmp = `${this.activeMainLink}.tmp-${crypto.randomBytes(6).toString('hex')}`;
    await fs.symlink(rel, tmp);
    await fs.rename(tmp, this.activeMainLink);
  }

  private sessionWorktreePath(sessionId: string): string {
    return path.join(this.sessionWorktreesDir, sessionId);
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new AppsStoreError('not_initialized', 'AppsStore.init() must be awaited first.');
    }
  }

  /**
   * Chain `fn` after the prior publish/rollback so the bare repo's
   * `main` advances atomically. Rejections from earlier links are
   * swallowed for chaining purposes — the originator already saw
   * the rejection at its own `await` site.
   */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.publishChain.catch(() => undefined).then(fn);
    this.publishChain = next;
    return next;
  }
}

function sessionBranchName(sessionId: string): string {
  return `sessions/${sessionId}`;
}

function assertSafeId(id: string, code: 'invalid_app_id' | 'invalid_session_id'): void {
  if (!SAFE_ID_RE.test(id)) {
    throw new AppsStoreError(
      code,
      `"${id}" is not a valid id (allowed: ASCII letter or digit, then letters/digits/_/-).`,
    );
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p: string): Promise<Record<string, unknown>> {
  const text = await fs.readFile(p, 'utf8');
  const parsed: unknown = JSON.parse(text);
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}
