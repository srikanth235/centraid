// governance: allow-repo-hygiene file-size-limit publish/rollback/delete critical sections share private state — keeping them in one file preserves the per-store mutex invariant
// Gateway-owned git store for editing sessions. Draft DATA lives in the vault's
// ext draft band, never in a branched data.sqlite beside the code. Rollback is a
// NEW forward commit overlaying an older subtree, never a reset, so `git log
// main` stays the audit of everything live. Publish and rollback serialize
// through one per-store mutex, and fresh-path-per-publish rotates require()
// cache lines, since the runtime keys its handler cache on path.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { run, runRaw, revParse } from "./git.js";
import { WorktreeStoreError } from "./types.js";
import type {
  WorktreeStoreOptions,
  PublishInput,
  PublishResult,
  RollbackInput,
  RollbackResult,
  SessionHandle,
  VersionEntry,
} from "./types.js";

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** No dot, so a tree-traversing `..` is impossible by construction. */
const SAFE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/iu;

const ACTIVE_MAIN_LINK = "active-main";

export class WorktreeStore {
  private readonly root: string;
  private readonly bareDir: string;
  private readonly worktreesDir: string;
  private readonly mainWorktreesDir: string;
  private readonly sessionWorktreesDir: string;
  private readonly activeMainLink: string;
  private activeMainDir: string | undefined;
  private publishChain: Promise<unknown> = Promise.resolve();
  private initialized = false;

  constructor(options: WorktreeStoreOptions) {
    this.root = options.root;
    this.bareDir = path.join(options.root, "apps.git");
    this.worktreesDir = path.join(options.root, "worktrees");
    this.mainWorktreesDir = path.join(this.worktreesDir, "main");
    this.sessionWorktreesDir = path.join(this.worktreesDir, "sessions");
    this.activeMainLink = path.join(options.root, ACTIVE_MAIN_LINK);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await fs.mkdir(this.worktreesDir, { recursive: true });
    await fs.mkdir(this.mainWorktreesDir, { recursive: true });
    await fs.mkdir(this.sessionWorktreesDir, { recursive: true });

    if (!(await pathExists(path.join(this.bareDir, "HEAD")))) {
      await fs.mkdir(this.bareDir, { recursive: true });
      // `-b main` pins HEAD; otherwise `init.defaultBranch` wins.
      await run(["init", "--bare", "-b", "main", this.bareDir], {
        cwd: this.root,
      });
    }

    if (!(await revParse(this.bareDir, "refs/heads/main"))) {
      const initialSha = await run(
        ["commit-tree", EMPTY_TREE_SHA, "-m", "centraid: init apps repo"],
        { cwd: this.bareDir }
      );
      await run(["update-ref", "refs/heads/main", initialSha], {
        cwd: this.bareDir,
      });
    }

    await run(["worktree", "prune"], { cwd: this.bareDir });
    const mainSha = (await revParse(this.bareDir, "refs/heads/main")) ?? "";
    this.activeMainDir = await this.ensureMainMaterialization(mainSha);
    await this.updateActiveMainLink(this.activeMainDir);
    this.initialized = true;
  }

  getActiveMainDir(): string | undefined {
    return this.activeMainDir;
  }

  /** Never rotates, unlike `getActiveMainDir()`, so a caller that resolves it once survives a version swap. */
  getActiveMainLink(): string {
    return this.activeMainLink;
  }

  get bareRepoDir(): string {
    return this.bareDir;
  }

  async listApps(): Promise<string[]> {
    this.assertInitialized();
    const out = await runRaw(
      ["ls-tree", "--name-only", "refs/heads/main:apps"],
      {
        cwd: this.bareDir,
        allowNonZero: true,
      }
    );
    if (out.code !== 0) return []; // no `apps/` dir yet
    return out.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && SAFE_ID_RE.test(line))
      .sort();
  }

  async listAppsWithMeta(): Promise<
    Array<{
      id: string;
      name?: string;
      description?: string;
      kind?: "app" | "automation";
      iconKey?: string;
      colorKey?: string;
    }>
  > {
    this.assertInitialized();
    const ids = await this.listApps();
    const mainDir = this.activeMainDir;
    if (!mainDir || ids.length === 0) return [];
    const rows = await Promise.all(
      ids.map(async (id) => {
        const appDir = path.join(mainDir, "apps", id);
        const manifest: Record<string, unknown> = await readJson(
          path.join(appDir, "app.json")
        ).catch(() => ({}));
        return {
          id,
          ...(typeof manifest.name === "string" ? { name: manifest.name } : {}),
          ...(typeof manifest.description === "string"
            ? { description: manifest.description }
            : {}),
          ...(manifest.kind === "automation" || manifest.kind === "app"
            ? { kind: manifest.kind as "app" | "automation" }
            : {}),
          // Pass-through: the shells validate against the token sets.
          ...(typeof manifest.iconKey === "string"
            ? { iconKey: manifest.iconKey }
            : {}),
          ...(typeof manifest.colorKey === "string"
            ? { colorKey: manifest.colorKey }
            : {}),
        };
      })
    );
    return rows;
  }

  /** FORWARD-ONLY: the deletion is a fresh commit. */
  deleteApp(
    appId: string
  ): Promise<{ sha: string; materializedMainDir: string }> {
    return this.serialize(() => this.deleteAppCritical(appId));
  }

  async resolveActiveAppDir(appId: string): Promise<string | undefined> {
    assertSafeId(appId, "invalid_app_id");
    this.assertInitialized();
    const mainDir = this.activeMainDir;
    if (!mainDir) return undefined;
    const appDir = path.join(mainDir, "apps", appId);
    return (await pathExists(appDir)) ? appDir : undefined;
  }

  /** Refuses `session_missing` when the worktree is not registered: a typo'd id would otherwise materialize a plain directory that fails `git add`. */
  async snapshotSessionAppDir(
    sessionId: string,
    appId: string
  ): Promise<string> {
    assertSafeId(sessionId, "invalid_session_id");
    assertSafeId(appId, "invalid_app_id");
    this.assertInitialized();
    const worktreeRoot = this.sessionWorktreePath(sessionId);
    if (!(await pathExists(path.join(worktreeRoot, ".git")))) {
      throw new WorktreeStoreError(
        "session_missing",
        `Session "${sessionId}" has no worktree — open it first via openSession().`
      );
    }
    const dir = path.join(worktreeRoot, "apps", appId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async openSession(sessionId: string): Promise<SessionHandle> {
    assertSafeId(sessionId, "invalid_session_id");
    this.assertInitialized();
    const worktreePath = this.sessionWorktreePath(sessionId);
    if (await pathExists(worktreePath)) {
      throw new WorktreeStoreError(
        "session_exists",
        `Session "${sessionId}" already has a worktree at ${worktreePath}.`
      );
    }
    const branch = sessionBranchName(sessionId);
    await run(
      ["worktree", "add", "-b", branch, worktreePath, "refs/heads/main"],
      {
        cwd: this.bareDir,
      }
    );
    return { id: sessionId, branch, worktreePath };
  }

  async closeSession(sessionId: string): Promise<void> {
    assertSafeId(sessionId, "invalid_session_id");
    this.assertInitialized();
    const worktreePath = this.sessionWorktreePath(sessionId);
    if (await pathExists(worktreePath)) {
      await runRaw(["worktree", "remove", "--force", worktreePath], {
        cwd: this.bareDir,
        allowNonZero: true,
      });
    }
    await run(["worktree", "prune"], { cwd: this.bareDir });
    const branch = sessionBranchName(sessionId);
    await runRaw(["branch", "-D", branch], {
      cwd: this.bareDir,
      allowNonZero: true,
    });
  }

  async listSessions(): Promise<string[]> {
    this.assertInitialized();
    const out = await run(
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/sessions/"],
      {
        cwd: this.bareDir,
      }
    );
    if (!out) return [];
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("sessions/"))
      .map((line) => line.slice("sessions/".length));
  }

  async sessionAppIds(sessionId: string): Promise<string[]> {
    assertSafeId(sessionId, "invalid_session_id");
    this.assertInitialized();
    try {
      const entries = await fs.readdir(
        path.join(this.sessionWorktreePath(sessionId), "apps"),
        {
          withFileTypes: true,
        }
      );
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  /** Serialized, so two parallel publishes cannot race on `main`. */
  publish(input: PublishInput): Promise<PublishResult> {
    return this.serialize(() => this.publishCritical(input));
  }

  /** FORWARD-ONLY and untagged, so the log stays chronological and tag versions monotonic. CODE-ONLY: no pre-merge hook (#160/#144). */
  rollback(input: RollbackInput): Promise<RollbackResult> {
    return this.serialize(() => this.rollbackCritical(input));
  }

  async listVersions(appId: string): Promise<VersionEntry[]> {
    assertSafeId(appId, "invalid_app_id");
    this.assertInitialized();
    const out = await run(
      [
        "for-each-ref",
        "--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)",
        `refs/tags/${appId}/v*`,
      ],
      { cwd: this.bareDir }
    );
    if (!out) return [];
    const mainAppTree = await this.treeSha(`refs/heads/main:apps/${appId}`);
    const rows = (
      await Promise.all(
        out.split("\n").map(async (line): Promise<VersionEntry | undefined> => {
          const [tag, sha, uploadedAt] = line.split("\t");
          if (!tag || !sha || !uploadedAt) return undefined;
          const m = /\/v(?<version>\d+)$/u.exec(tag);
          if (!m) return undefined;
          const version = Math.trunc(Number(m.groups?.version ?? ""));
          if (!Number.isFinite(version)) return undefined;
          const tagAppTree = await this.treeSha(`${tag}:apps/${appId}`);
          const active =
            mainAppTree !== undefined && tagAppTree === mainAppTree;
          return { tag, version, sha, uploadedAt, active };
        })
      )
    ).filter((row): row is VersionEntry => row !== undefined);
    rows.sort((a, b) => b.version - a.version);
    return rows;
  }

  private async treeSha(refPath: string): Promise<string | undefined> {
    const r = await runRaw(["rev-parse", refPath], {
      cwd: this.bareDir,
      allowNonZero: true,
    });
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  private async publishCritical(input: PublishInput): Promise<PublishResult> {
    const { sessionId, appId, message } = input;
    assertSafeId(sessionId, "invalid_session_id");
    assertSafeId(appId, "invalid_app_id");
    this.assertInitialized();

    const sessionDir = this.sessionWorktreePath(sessionId);
    if (!(await pathExists(sessionDir))) {
      throw new WorktreeStoreError(
        "session_missing",
        `Session "${sessionId}" has no worktree — call openSession() first.`
      );
    }

    const appSubdir = `apps/${appId}`;
    await fs.mkdir(path.join(sessionDir, appSubdir), { recursive: true });
    await run(["add", "--", appSubdir], { cwd: sessionDir });

    const diff = await runRaw(
      ["diff", "--cached", "--quiet", "--", appSubdir],
      {
        cwd: sessionDir,
        allowNonZero: true,
      }
    );
    if (diff.code === 0) {
      throw new WorktreeStoreError(
        "no_changes",
        `Session "${sessionId}" has no staged changes under ${appSubdir}.`
      );
    }

    const subject = `${appId}: ${message}`;
    await run(["commit", "-m", subject], { cwd: sessionDir });

    // Inside the mutex the only writer that can have advanced main is a completed publish, so `merge-base` is the exact divergence probe.
    const mainBeforeSha =
      (await revParse(this.bareDir, "refs/heads/main")) ?? "";
    const sessionBranch = sessionBranchName(sessionId);
    const mergeBase = await run(
      ["merge-base", "refs/heads/main", sessionBranch],
      {
        cwd: this.bareDir,
      }
    );
    if (mergeBase !== mainBeforeSha) {
      await run(["rebase", "refs/heads/main"], { cwd: sessionDir });
    }

    const sessionTipSha = await run(["rev-parse", "HEAD"], { cwd: sessionDir });

    // AFTER the rebase and BEFORE the ff-merge, inside the mutex: a throw here aborts before `main` advances or a tag is minted (#144/#286).
    if (input.beforeMerge) {
      await input.beforeMerge(path.join(sessionDir, "apps", appId));
    }

    // BEFORE the tag write: a fresh store on the same disk is off this publish chain but still honors existing tags.
    const nextN = await this.nextVersionNumber(appId);
    const tag = `${appId}/v${nextN}`;
    await run(["tag", tag, sessionTipSha], { cwd: this.bareDir });

    // After the rebase main is an ancestor of session-tip.
    await run(["update-ref", "refs/heads/main", sessionTipSha, mainBeforeSha], {
      cwd: this.bareDir,
    });

    const newMainDir = await this.ensureMainMaterialization(sessionTipSha);
    await this.swapActiveMain(newMainDir);

    return {
      versionTag: tag,
      sha: sessionTipSha,
      materializedMainDir: newMainDir,
    };
  }

  private async rollbackCritical(
    input: RollbackInput
  ): Promise<RollbackResult> {
    const { appId, versionTag } = input;
    assertSafeId(appId, "invalid_app_id");
    this.assertInitialized();

    if (!(await revParse(this.bareDir, `refs/tags/${versionTag}`))) {
      throw new WorktreeStoreError(
        "tag_missing",
        `Tag "${versionTag}" does not exist in the apps repo.`
      );
    }

    const txId = `_rollback-${crypto.randomBytes(6).toString("hex")}`;
    const txDir = path.join(this.worktreesDir, txId);
    await run(["worktree", "add", "--detach", txDir, "refs/heads/main"], {
      cwd: this.bareDir,
    });
    try {
      const appSubdir = `apps/${appId}`;
      await run(["checkout", `refs/tags/${versionTag}`, "--", appSubdir], {
        cwd: txDir,
      });
      await run(["add", "--", appSubdir], { cwd: txDir });
      const diff = await runRaw(
        ["diff", "--cached", "--quiet", "--", appSubdir],
        {
          cwd: txDir,
          allowNonZero: true,
        }
      );
      if (diff.code === 0) {
        throw new WorktreeStoreError(
          "no_changes",
          `Rollback to ${versionTag} would produce no change — current main already matches.`
        );
      }
      const subject = `rollback: ${appId} -> ${versionTag}`;
      await run(["commit", "-m", subject], { cwd: txDir });
      // NO pre-merge hook, deliberately (#160/#144): rollback is CODE-ONLY. Ext DDL is forward-only, so the band stays ahead of the rolled-back code.
      const newSha = await run(["rev-parse", "HEAD"], { cwd: txDir });
      const oldMainSha =
        (await revParse(this.bareDir, "refs/heads/main")) ?? "";
      await run(["update-ref", "refs/heads/main", newSha, oldMainSha], {
        cwd: this.bareDir,
      });
      const newMainDir = await this.ensureMainMaterialization(newSha);
      await this.swapActiveMain(newMainDir);
      return { sha: newSha, materializedMainDir: newMainDir };
    } finally {
      await runRaw(["worktree", "remove", "--force", txDir], {
        cwd: this.bareDir,
        allowNonZero: true,
      });
      await run(["worktree", "prune"], { cwd: this.bareDir });
    }
  }

  private async deleteAppCritical(
    appId: string
  ): Promise<{ sha: string; materializedMainDir: string }> {
    assertSafeId(appId, "invalid_app_id");
    this.assertInitialized();

    const txId = `_delete-${crypto.randomBytes(6).toString("hex")}`;
    const txDir = path.join(this.worktreesDir, txId);
    await run(["worktree", "add", "--detach", txDir, "refs/heads/main"], {
      cwd: this.bareDir,
    });
    try {
      const appSubdir = `apps/${appId}`;
      const rm = await runRaw(
        ["rm", "-r", "--ignore-unmatch", "--", appSubdir],
        {
          cwd: txDir,
          allowNonZero: true,
        }
      );
      if (rm.code !== 0) {
        throw new WorktreeStoreError(
          "no_changes",
          `App "${appId}" not on main — nothing to delete.`
        );
      }
      const diff = await runRaw(
        ["diff", "--cached", "--quiet", "--", appSubdir],
        {
          cwd: txDir,
          allowNonZero: true,
        }
      );
      if (diff.code === 0) {
        throw new WorktreeStoreError(
          "no_changes",
          `App "${appId}" not on main — nothing to delete.`
        );
      }
      await run(["commit", "-m", `delete: ${appId}`], { cwd: txDir });
      const newSha = await run(["rev-parse", "HEAD"], { cwd: txDir });
      const oldMainSha =
        (await revParse(this.bareDir, "refs/heads/main")) ?? "";
      await run(["update-ref", "refs/heads/main", newSha, oldMainSha], {
        cwd: this.bareDir,
      });
      const versions = await this.listVersions(appId);
      await Promise.all(
        versions.map(async (version) =>
          runRaw(["tag", "-d", version.tag], {
            cwd: this.bareDir,
            allowNonZero: true,
          })
        )
      );
      const newMainDir = await this.ensureMainMaterialization(newSha);
      await this.swapActiveMain(newMainDir);
      return { sha: newSha, materializedMainDir: newMainDir };
    } finally {
      await runRaw(["worktree", "remove", "--force", txDir], {
        cwd: this.bareDir,
        allowNonZero: true,
      });
      await run(["worktree", "prune"], { cwd: this.bareDir });
    }
  }

  private async nextVersionNumber(appId: string): Promise<number> {
    const versions = await this.listVersions(appId);
    if (versions.length === 0) return 1;
    const highest = versions[0]?.version ?? 0;
    return highest + 1;
  }

  private async ensureMainMaterialization(sha: string): Promise<string> {
    const dir = path.join(this.mainWorktreesDir, sha);
    if (await pathExists(dir)) {
      // If git no longer remembers the directory as a worktree, re-adding refuses on a non-empty path — trust the on-disk tree.
      return dir;
    }
    await run(["worktree", "add", "--detach", dir, sha], { cwd: this.bareDir });
    return dir;
  }

  /** Repointed BEFORE the old dir is removed, so a reader resolving the stable path never observes a dangling link. */
  private async swapActiveMain(newDir: string): Promise<void> {
    const previous = this.activeMainDir;
    this.activeMainDir = newDir;
    await this.updateActiveMainLink(newDir);
    if (previous && previous !== newDir) {
      await runRaw(["worktree", "remove", "--force", previous], {
        cwd: this.bareDir,
        allowNonZero: true,
      });
      await run(["worktree", "prune"], { cwd: this.bareDir });
      await fs.rm(previous, { recursive: true, force: true });
    }
  }

  /** RELATIVE to the store root, so the store moves wholesale. Write-temp-then-rename, so a reader never sees a half-written link. */
  private async updateActiveMainLink(targetDir: string): Promise<void> {
    const rel = path.relative(this.root, targetDir);
    const tmp = `${this.activeMainLink}.tmp-${crypto.randomBytes(6).toString("hex")}`;
    await fs.symlink(rel, tmp);
    await fs.rename(tmp, this.activeMainLink);
  }

  private sessionWorktreePath(sessionId: string): string {
    return path.join(this.sessionWorktreesDir, sessionId);
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new WorktreeStoreError(
        "not_initialized",
        "WorktreeStore.init() must be awaited first."
      );
    }
  }

  /** Earlier rejections are swallowed for chaining: the originator saw it. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.publishChain.catch(() => undefined).then(fn);
    this.publishChain = next;
    return next;
  }
}

function sessionBranchName(sessionId: string): string {
  return `sessions/${sessionId}`;
}

function assertSafeId(
  id: string,
  code: "invalid_app_id" | "invalid_session_id"
): void {
  if (!SAFE_ID_RE.test(id)) {
    throw new WorktreeStoreError(
      code,
      `"${id}" is not a valid id (allowed: ASCII letter or digit, then letters/digits/_/-).`
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
  const text = await fs.readFile(p, "utf8");
  const parsed: unknown = JSON.parse(text);
  return parsed && typeof parsed === "object"
    ? (parsed as Record<string, unknown>)
    : {};
}
