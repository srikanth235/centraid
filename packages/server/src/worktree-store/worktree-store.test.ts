import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

// governance: allow-repo-hygiene file-size-limit unit tests for one module — splitting by topic would scatter the shared helpers
import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { run } from "./git.js";
import { WorktreeStoreError } from "./types.js";
import { WorktreeStore } from "./worktree-store.js";

async function makeTempRoot(): Promise<string> {
  const dir = await tempDir("apps-store-");
  return dir;
}

async function rmTempRoot(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}

async function expectRejectsWithCode(
  op: () => Promise<unknown>,
  code: string
): Promise<void> {
  let err: unknown;
  try {
    await op();
  } catch (error) {
    err = error;
  }
  expect(err).toBeInstanceOf(WorktreeStoreError);
  expect((err as WorktreeStoreError).code).toBe(code);
}

async function seedApp(
  sessionWorktree: string,
  appId: string,
  marker: string
): Promise<void> {
  const appDir = path.join(sessionWorktree, "apps", appId);
  await fs.mkdir(path.join(appDir, "actions"), { recursive: true });
  await fs.writeFile(
    path.join(appDir, "app.json"),
    JSON.stringify({ id: appId, name: appId, marker }, null, 2)
  );
  await fs.writeFile(
    path.join(appDir, "actions", "noop.js"),
    `// marker: ${marker}\nexport default async () => ({ status: 200, body: {} });\n`
  );
}

describe("worktree-store", () => {
  test("init creates the layout and is idempotent", async () => {
    const root = await makeTempRoot();
    try {
      const store = new WorktreeStore({ root });
      await store.init();

      const mainDir = store.getActiveMainDir();
      expect(mainDir).toBeTypeOf("string");
      expect(mainDir!.length).toBeGreaterThan(0);
      expect(
        mainDir!.startsWith(path.join(root, "worktrees", "main") + path.sep)
      ).toBe(true);

      const head = await fs.readFile(
        path.join(root, "apps.git", "HEAD"),
        "utf8"
      );
      expect(head).toMatch(/refs\/heads\/main/u);
      const mainSha = await run(["rev-parse", "refs/heads/main"], {
        cwd: path.join(root, "apps.git"),
      });
      expect(mainSha).toHaveLength(40);

      const store2 = new WorktreeStore({ root });
      await store2.init();
      expect(store2.getActiveMainDir()).toBe(mainDir);
    } finally {
      await rmTempRoot(root);
    }
  });

  test("active-main symlink stays pinned across publish + rollback", async () => {
    const root = await makeTempRoot();
    try {
      const store = new WorktreeStore({ root });
      await store.init();

      const link = store.getActiveMainLink();
      expect(link).toBe(path.join(root, "active-main"));
      await expect(fs.realpath(link)).resolves.toBe(
        await fs.realpath(store.getActiveMainDir()!)
      );

      const s1 = await store.openSession("s1");
      await seedApp(s1.worktreePath, "todo", "one");
      const r1 = await store.publish({
        sessionId: "s1",
        appId: "todo",
        message: "v1",
      });
      await store.closeSession("s1");
      await expect(fs.realpath(link)).resolves.toBe(
        await fs.realpath(r1.materializedMainDir)
      );
      const viaLink = JSON.parse(
        await fs.readFile(path.join(link, "apps", "todo", "app.json"), "utf8")
      ) as { marker: string };
      expect(viaLink.marker).toBe("one");

      const s2 = await store.openSession("s2");
      await seedApp(s2.worktreePath, "todo", "two");
      const r2 = await store.publish({
        sessionId: "s2",
        appId: "todo",
        message: "v2",
      });
      await store.closeSession("s2");
      await expect(fs.realpath(link)).resolves.toBe(
        await fs.realpath(r2.materializedMainDir)
      );

      const rb = await store.rollback({ appId: "todo", versionTag: "todo/v1" });
      await expect(fs.realpath(link)).resolves.toBe(
        await fs.realpath(rb.materializedMainDir)
      );
      const afterRollback = JSON.parse(
        await fs.readFile(path.join(link, "apps", "todo", "app.json"), "utf8")
      ) as { marker: string };
      expect(afterRollback.marker).toBe("one");
    } finally {
      await rmTempRoot(root);
    }
  });

  test("openSession creates a worktree branched off main; multiple sessions coexist", async () => {
    const root = await makeTempRoot();
    try {
      const store = new WorktreeStore({ root });
      await store.init();

      const a = await store.openSession("alpha");
      const b = await store.openSession("beta");

      expect(a.id).toBe("alpha");
      expect(a.branch).toBe("sessions/alpha");
      expect(
        a.worktreePath.endsWith(path.join("worktrees", "sessions", "alpha"))
      ).toBe(true);
      await expect(
        fs
          .stat(a.worktreePath)
          .then((s) => s.isDirectory())
          .catch(() => false)
      ).resolves.toBe(true);

      expect(b.id).toBe("beta");
      expect(a.worktreePath).not.toBe(b.worktreePath);

      const sessions = await store.listSessions();
      expect([...sessions].sort()).toStrictEqual(["alpha", "beta"]);
    } finally {
      await rmTempRoot(root);
    }
  });

  test("openSession twice for the same id throws session_exists", async () => {
    expect.assertions(2);
    const root = await makeTempRoot();
    try {
      const store = new WorktreeStore({ root });
      await store.init();
      await store.openSession("alpha");
      await expectRejectsWithCode(
        () => store.openSession("alpha"),
        "session_exists"
      );
    } finally {
      await rmTempRoot(root);
    }
  });

  test('publishes a plain-slug app id; rejects dotted and ".." ids (#98)', async () => {
    const root = await makeTempRoot();
    try {
      const store = new WorktreeStore({ root });
      await store.init();

      const s = await store.openSession("desktop-brief");
      await seedApp(s.worktreePath, "brief", "one");
      const r = await store.publish({
        sessionId: "desktop-brief",
        appId: "brief",
        message: "v1",
      });
      expect(r.versionTag).toBe("brief/v1");
      expect((await store.listApps()).sort()).toStrictEqual(["brief"]);

      await expectRejectsWithCode(
        () => store.openSession("auto.brief"),
        "invalid_session_id"
      );
      await expectRejectsWithCode(
        () => store.openSession("bad..id"),
        "invalid_session_id"
      );
    } finally {
      await rmTempRoot(root);
    }
  });

  test("closeSession removes worktree + branch and is idempotent", async () => {
    const root = await makeTempRoot();
    try {
      const store = new WorktreeStore({ root });
      await store.init();
      const handle = await store.openSession("alpha");

      await store.closeSession("alpha");
      const stillThere = await fs
        .access(handle.worktreePath)
        .then(() => true)
        .catch(() => false);
      expect(stillThere).toBe(false);
      await expect(store.listSessions()).resolves.toStrictEqual([]);

      await store.closeSession("alpha");
    } finally {
      await rmTempRoot(root);
    }
  });

  test("publish of a brand-new app tags v1 and materializes new main", async () => {
    const root = await makeTempRoot();
    try {
      const store = new WorktreeStore({ root });
      await store.init();
      const mainBefore = store.getActiveMainDir()!;

      const session = await store.openSession("s1");
      await seedApp(session.worktreePath, "todo", "first");

      const result = await store.publish({
        sessionId: "s1",
        appId: "todo",
        message: "initial",
      });

      expect(result.versionTag).toBe("todo/v1");
      expect(result.sha).toHaveLength(40);
      expect(
        result.materializedMainDir.startsWith(
          path.join(root, "worktrees", "main") + path.sep
        )
      ).toBe(true);
      expect(result.materializedMainDir).not.toBe(mainBefore);
      expect(store.getActiveMainDir()).toBe(result.materializedMainDir);

      const appDir = await store.resolveActiveAppDir("todo");
      expect(appDir).toBe(
        path.join(result.materializedMainDir, "apps", "todo")
      );
      const appJson = JSON.parse(
        await fs.readFile(path.join(appDir!, "app.json"), "utf8")
      ) as {
        marker: string;
      };
      expect(appJson.marker).toBe("first");

      const oldExists = await fs
        .access(mainBefore)
        .then(() => true)
        .catch(() => false);
      expect(oldExists).toBe(false);
    } finally {
      await rmTempRoot(root);
    }
  });

  test("publish increments to v2 on the next publish of the same app", async () => {
    const root = await makeTempRoot();
    try {
      const store = new WorktreeStore({ root });
      await store.init();

      const s1 = await store.openSession("s1");
      await seedApp(s1.worktreePath, "todo", "first");
      const r1 = await store.publish({
        sessionId: "s1",
        appId: "todo",
        message: "v1",
      });
      expect(r1.versionTag).toBe("todo/v1");
      await store.closeSession("s1");

      const s2 = await store.openSession("s2");
      await seedApp(s2.worktreePath, "todo", "second");
      const r2 = await store.publish({
        sessionId: "s2",
        appId: "todo",
        message: "v2",
      });
      expect(r2.versionTag).toBe("todo/v2");

      const versions = await store.listVersions("todo");
      expect(versions.map((v) => v.tag)).toStrictEqual(["todo/v2", "todo/v1"]);
      expect(versions.map((v) => v.active)).toStrictEqual([true, false]);
    } finally {
      await rmTempRoot(root);
    }
  });

  test("publish is path-scoped: a session that edits two apps publishes only one", async () => {
    const root = await makeTempRoot();
    try {
      const store = new WorktreeStore({ root });
      await store.init();

      const session = await store.openSession("multi");
      await seedApp(session.worktreePath, "todo", "todo-1");
      await seedApp(session.worktreePath, "notes", "notes-1");

      await store.publish({
        sessionId: "multi",
        appId: "todo",
        message: "todo only",
      });

      const notesActive = await store.resolveActiveAppDir("notes");
      expect(notesActive).toBeUndefined();
      const notesInSession = await fs
        .stat(path.join(session.worktreePath, "apps", "notes", "app.json"))
        .then((s) => s.isFile())
        .catch(() => false);
      expect(notesInSession).toBe(true);

      const todoActive = await store.resolveActiveAppDir("todo");
      expect(todoActive).toBeTypeOf("string");
      expect(todoActive!.length).toBeGreaterThan(0);
    } finally {
      await rmTempRoot(root);
    }
  });

  test("publish with no staged changes under apps/<appId>/ throws no_changes", async () => {
    expect.assertions(2);
    const root = await makeTempRoot();
    try {
      const store = new WorktreeStore({ root });
      await store.init();
      await store.openSession("empty");
      await expectRejectsWithCode(
        () =>
          store.publish({
            sessionId: "empty",
            appId: "todo",
            message: "nothing to ship",
          }),
        "no_changes"
      );
    } finally {
      await rmTempRoot(root);
    }
  });

  test("concurrent publishes on the same store serialize and both succeed", async () => {
    const root = await makeTempRoot();
    try {
      const store = new WorktreeStore({ root });
      await store.init();

      const a = await store.openSession("a");
      const b = await store.openSession("b");
      await seedApp(a.worktreePath, "todo", "from-a");
      await seedApp(b.worktreePath, "notes", "from-b");

      const [ra, rb] = await Promise.all([
        store.publish({ sessionId: "a", appId: "todo", message: "from a" }),
        store.publish({ sessionId: "b", appId: "notes", message: "from b" }),
      ]);

      expect(ra.versionTag).toBe("todo/v1");
      expect(rb.versionTag).toBe("notes/v1");

      const todoDir = await store.resolveActiveAppDir("todo");
      const notesDir = await store.resolveActiveAppDir("notes");
      expect(todoDir).toBeTypeOf("string");
      expect(todoDir!.length).toBeGreaterThan(0);
      expect(notesDir).toBeTypeOf("string");
      expect(notesDir!.length).toBeGreaterThan(0);

      expect(store.getActiveMainDir()).toBe(rb.materializedMainDir);
    } finally {
      await rmTempRoot(root);
    }
  });

  test("rollback overlays the old subtree onto main without minting a tag", async () => {
    const root = await makeTempRoot();
    try {
      const store = new WorktreeStore({ root });
      await store.init();

      const s1 = await store.openSession("s1");
      await seedApp(s1.worktreePath, "todo", "one");
      await store.publish({ sessionId: "s1", appId: "todo", message: "v1" });
      await store.closeSession("s1");

      const s2 = await store.openSession("s2");
      await seedApp(s2.worktreePath, "todo", "two");
      await store.publish({ sessionId: "s2", appId: "todo", message: "v2" });
      await store.closeSession("s2");

      const tagsBefore = await store.listVersions("todo");
      expect(tagsBefore.map((t) => t.tag)).toStrictEqual([
        "todo/v2",
        "todo/v1",
      ]);

      const rb = await store.rollback({ appId: "todo", versionTag: "todo/v1" });
      expect(rb.sha).toHaveLength(40);

      const appDir = await store.resolveActiveAppDir("todo");
      expect(appDir).toBeTypeOf("string");
      expect(appDir!.length).toBeGreaterThan(0);
      const appJson = JSON.parse(
        await fs.readFile(path.join(appDir!, "app.json"), "utf8")
      ) as {
        marker: string;
      };
      expect(appJson.marker).toBe("one");

      // No new tag minted — listVersions still shows v1 and v2 only.
      const tagsAfter = await store.listVersions("todo");
      expect(tagsAfter.map((t) => t.tag)).toStrictEqual(["todo/v2", "todo/v1"]);
      expect(tagsAfter.map((t) => t.active)).toStrictEqual([false, true]);

      const log = await run(["log", "--format=%s", "refs/heads/main"], {
        cwd: path.join(root, "apps.git"),
      });
      expect(log).toMatch(/rollback: todo -> todo\/v1/u);
    } finally {
      await rmTempRoot(root);
    }
  });

  test("rollback to a tag that matches current main throws no_changes", async () => {
    expect.assertions(2);
    const root = await makeTempRoot();
    try {
      const store = new WorktreeStore({ root });
      await store.init();
      const session = await store.openSession("s1");
      await seedApp(session.worktreePath, "todo", "one");
      await store.publish({ sessionId: "s1", appId: "todo", message: "v1" });

      await expectRejectsWithCode(
        () => store.rollback({ appId: "todo", versionTag: "todo/v1" }),
        "no_changes"
      );
    } finally {
      await rmTempRoot(root);
    }
  });

  test("rollback to a missing tag throws tag_missing", async () => {
    expect.assertions(2);
    const root = await makeTempRoot();
    try {
      const store = new WorktreeStore({ root });
      await store.init();
      await expectRejectsWithCode(
        () => store.rollback({ appId: "todo", versionTag: "todo/v9" }),
        "tag_missing"
      );
    } finally {
      await rmTempRoot(root);
    }
  });

  test("resolveActiveAppDir returns undefined for an app never published", async () => {
    const root = await makeTempRoot();
    try {
      const store = new WorktreeStore({ root });
      await store.init();
      await expect(store.resolveActiveAppDir("ghost")).resolves.toBeUndefined();
    } finally {
      await rmTempRoot(root);
    }
  });

  test("listVersions returns [] for an app with no tags", async () => {
    const root = await makeTempRoot();
    try {
      const store = new WorktreeStore({ root });
      await store.init();
      await expect(store.listVersions("ghost")).resolves.toStrictEqual([]);
    } finally {
      await rmTempRoot(root);
    }
  });

  test("deleteApp removes the app from main and reaps its version tags", async () => {
    const root = await makeTempRoot();
    try {
      const store = new WorktreeStore({ root });
      await store.init();

      const s1 = await store.openSession("s1");
      await seedApp(s1.worktreePath, "todo", "first");
      await store.publish({ sessionId: "s1", appId: "todo", message: "v1" });
      await store.closeSession("s1");

      const liveDir = await store.resolveActiveAppDir("todo");
      expect(liveDir).toBeTypeOf("string");
      expect(liveDir!.length).toBeGreaterThan(0);
      expect(
        (await store.listVersions("todo")).map((v) => v.tag)
      ).toStrictEqual(["todo/v1"]);

      const out = await store.deleteApp("todo");
      expect(out.sha).toHaveLength(40);

      await expect(store.resolveActiveAppDir("todo")).resolves.toBeUndefined();
      await expect(store.listVersions("todo")).resolves.toStrictEqual([]);
      await expect(store.listApps()).resolves.toStrictEqual([]);

      const log = await run(["log", "--format=%s", "refs/heads/main"], {
        cwd: path.join(root, "apps.git"),
      });
      expect(log).toMatch(/delete: todo/u);
    } finally {
      await rmTempRoot(root);
    }
  });

  test("deleteApp throws no_changes for an app that was never on main", async () => {
    expect.assertions(2);
    const root = await makeTempRoot();
    try {
      const store = new WorktreeStore({ root });
      await store.init();
      await expectRejectsWithCode(() => store.deleteApp("ghost"), "no_changes");
    } finally {
      await rmTempRoot(root);
    }
  });

  test("snapshotSessionAppDir refuses to create phantom dirs without a worktree", async () => {
    // Auto-creating the dir materializes a phantom session: a later openSession
    // 409s with `session_exists` and publish git-adds a plain directory and
    // fails — `session_missing` forces the caller to open one.
    const root = await makeTempRoot();
    try {
      const store = new WorktreeStore({ root });
      await store.init();
      await expectRejectsWithCode(
        () => store.snapshotSessionAppDir("phantom", "todo"),
        "session_missing"
      );
      await expect(store.sessionAppIds("phantom")).resolves.toStrictEqual([]);
      await expectRejectsWithCode(
        () =>
          store.publish({
            sessionId: "phantom",
            appId: "todo",
            message: "must not publish",
          }),
        "session_missing"
      );
      const phantomDir = path.join(root, "worktrees", "sessions", "phantom");
      const exists = await fs
        .stat(phantomDir)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    } finally {
      await rmTempRoot(root);
    }
  });

  test("init replants main if the ref went missing between runs", async () => {
    const root = await makeTempRoot();
    try {
      const first = new WorktreeStore({ root });
      await first.init();

      await fs.rm(path.join(root, "apps.git", "refs", "heads", "main"), {
        force: true,
      });
      await fs.rm(path.join(root, "apps.git", "packed-refs"), { force: true });

      const second = new WorktreeStore({ root });
      await second.init();

      const sha = await run(["rev-parse", "refs/heads/main"], {
        cwd: path.join(root, "apps.git"),
      });
      expect(sha).toHaveLength(40);
    } finally {
      await rmTempRoot(root);
    }
  });

  test("every method except init throws not_initialized before init()", async () => {
    expect.assertions(6);
    const root = await makeTempRoot();
    try {
      const store = new WorktreeStore({ root });
      await expectRejectsWithCode(
        () => store.resolveActiveAppDir("todo"),
        "not_initialized"
      );
      await expectRejectsWithCode(
        () => store.openSession("s1"),
        "not_initialized"
      );
      await expectRejectsWithCode(
        () => store.listSessions(),
        "not_initialized"
      );
    } finally {
      await rmTempRoot(root);
    }
  });

  test("app ids are validated", async () => {
    const root = await makeTempRoot();
    try {
      const store = new WorktreeStore({ root });
      await store.init();
      await expectRejectsWithCode(
        () => store.resolveActiveAppDir("../etc/passwd"),
        "invalid_app_id"
      );
      await expectRejectsWithCode(
        () => store.openSession("bad/name"),
        "invalid_session_id"
      );
    } finally {
      expect(crypto.randomUUID()).toHaveLength(36);
      await rmTempRoot(root);
    }
  });
});
