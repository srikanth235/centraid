import { promises as fs } from "node:fs";
import path from "node:path";

import { tempDir } from "@centraid/test-kit/temp-dir";
import { describe, expect, test } from "vitest";

import { run } from "./git.js";
import { exportToRemote, importFromRemote } from "./remote.js";
import { WorktreeStore } from "./worktree-store.js";

async function makeTempRoot(): Promise<string> {
  return tempDir("apps-store-remote-");
}

async function seedAndPublish(
  store: WorktreeStore,
  sessionId: string,
  appId: string,
  marker: string
) {
  const session = await store.openSession(sessionId);
  const appDir = path.join(session.worktreePath, "apps", appId, "actions");
  await fs.mkdir(appDir, { recursive: true });
  await fs.writeFile(
    path.join(session.worktreePath, "apps", appId, "app.json"),
    JSON.stringify({ id: appId, marker }, null, 2)
  );
  await fs.writeFile(path.join(appDir, "noop.js"), `// ${marker}\n`);
  const r = await store.publish({ sessionId, appId, message: marker });
  await store.closeSession(sessionId);
  return r;
}

describe("remote", () => {
  test("listApps returns app ids present on main, sorted", async () => {
    const root = await makeTempRoot();
    try {
      const store = new WorktreeStore({ root });
      await store.init();
      await expect(store.listApps()).resolves.toStrictEqual([]);

      await seedAndPublish(store, "s1", "todo", "one");
      await seedAndPublish(store, "s2", "notes", "two");

      await expect(store.listApps()).resolves.toStrictEqual(["notes", "todo"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("export pushes main + tags to a bare remote; import clones them back", async () => {
    const sourceRoot = await makeTempRoot();
    const remoteRoot = await makeTempRoot();
    const importRoot = await makeTempRoot();
    try {
      // Build a source store with two published versions of one app.
      const source = new WorktreeStore({ root: sourceRoot });
      await source.init();
      await seedAndPublish(source, "s1", "todo", "v1");
      await seedAndPublish(source, "s2", "todo", "v2");

      // Bare remote to receive the push (stands in for GitHub).
      const remoteBare = path.join(remoteRoot, "remote.git");
      await run(["init", "--bare", "-b", "main", remoteBare], {
        cwd: remoteRoot,
      });

      const exp = await exportToRemote(source.bareRepoDir, remoteBare);
      expect(exp.remoteName).toBe("origin");
      expect(
        exp.pushed.some((s) => s.includes("refs/heads/main"))
      ).toBeTruthy();

      // The remote now has main + both tags.
      const remoteTags = await run(["tag", "--list"], { cwd: remoteBare });
      expect(remoteTags).toMatch(/todo\/v1/u);
      expect(remoteTags).toMatch(/todo\/v2/u);

      // Import into a fresh gateway root, then init + serve.
      const imp = await importFromRemote(importRoot, remoteBare);
      expect(imp.bareDir).toBe(path.join(importRoot, "apps.git"));

      const imported = new WorktreeStore({ root: importRoot });
      await imported.init();
      const appDir = await imported.resolveActiveAppDir("todo");
      expect(appDir).toBeTruthy();
      const appJson = JSON.parse(
        await fs.readFile(path.join(appDir!, "app.json"), "utf8")
      ) as {
        marker: string;
      };
      expect(appJson.marker).toBe("v2");

      // Version history travelled with the tags.
      const versions = await imported.listVersions("todo");
      expect(versions.map((v) => v.tag)).toStrictEqual(["todo/v2", "todo/v1"]);
    } finally {
      await fs.rm(sourceRoot, { recursive: true, force: true });
      await fs.rm(remoteRoot, { recursive: true, force: true });
      await fs.rm(importRoot, { recursive: true, force: true });
    }
  });

  test("export is idempotent — re-running repoints the remote and re-pushes", async () => {
    const sourceRoot = await makeTempRoot();
    const remoteRoot = await makeTempRoot();
    try {
      const source = new WorktreeStore({ root: sourceRoot });
      await source.init();
      await seedAndPublish(source, "s1", "todo", "v1");

      const remoteBare = path.join(remoteRoot, "remote.git");
      await run(["init", "--bare", "-b", "main", remoteBare], {
        cwd: remoteRoot,
      });

      await exportToRemote(source.bareRepoDir, remoteBare);
      // Second publish + re-export must not fail on the existing remote.
      await seedAndPublish(source, "s2", "todo", "v2");
      const again = await exportToRemote(source.bareRepoDir, remoteBare);
      expect(again.remoteName).toBe("origin");

      const remoteTags = await run(["tag", "--list"], { cwd: remoteBare });
      expect(remoteTags).toMatch(/todo\/v2/u);
    } finally {
      await fs.rm(sourceRoot, { recursive: true, force: true });
      await fs.rm(remoteRoot, { recursive: true, force: true });
    }
  });

  test("importFromRemote refuses when apps.git already exists", async () => {
    const root = await makeTempRoot();
    const remoteRoot = await makeTempRoot();
    try {
      const store = new WorktreeStore({ root });
      await store.init(); // creates root/apps.git

      const remoteBare = path.join(remoteRoot, "remote.git");
      await run(["init", "--bare", "-b", "main", remoteBare], {
        cwd: remoteRoot,
      });

      await expect(
        (() => importFromRemote(root, remoteBare))()
      ).rejects.toThrow(/already exists/u);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(remoteRoot, { recursive: true, force: true });
    }
  });
});
