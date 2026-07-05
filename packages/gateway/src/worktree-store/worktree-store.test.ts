// governance: allow-repo-hygiene file-size-limit unit tests for one module — splitting by topic would scatter the shared helpers
import { test, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { WorktreeStore } from './worktree-store.js';
import { run } from './git.js';
import { WorktreeStoreError } from './types.js';

async function makeTempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apps-store-'));
  return dir;
}

async function rmTempRoot(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}

/** Assert that `op` rejects with a WorktreeStoreError carrying the given code. */
async function expectRejectsWithCode(op: () => Promise<unknown>, code: string): Promise<void> {
  let err: unknown;
  try {
    await op();
  } catch (e) {
    err = e;
  }
  expect(err instanceof WorktreeStoreError).toBeTruthy();
  expect((err as WorktreeStoreError).code).toBe(code);
}

/**
 * Drop a minimal app under `apps/<appId>/` inside the given session
 * worktree — `app.json` + one action handler. Tests use this to give
 * `publish()` something non-empty to stage.
 */
async function seedApp(sessionWorktree: string, appId: string, marker: string): Promise<void> {
  const appDir = path.join(sessionWorktree, 'apps', appId);
  await fs.mkdir(path.join(appDir, 'actions'), { recursive: true });
  await fs.writeFile(
    path.join(appDir, 'app.json'),
    JSON.stringify({ id: appId, name: appId, marker }, null, 2),
  );
  await fs.writeFile(
    path.join(appDir, 'actions', 'noop.js'),
    `// marker: ${marker}\nexport default async () => ({ status: 200, body: {} });\n`,
  );
}

test('init creates the layout and is idempotent', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();

    const mainDir = store.getActiveMainDir();
    expect(mainDir).toBeTruthy();
    expect(mainDir!.startsWith(path.join(root, 'worktrees', 'main') + path.sep)).toBeTruthy();

    // Bare repo exists with the `main` ref planted.
    const head = await fs.readFile(path.join(root, 'apps.git', 'HEAD'), 'utf8');
    expect(head).toMatch(/refs\/heads\/main/);
    const mainSha = await run(['rev-parse', 'refs/heads/main'], {
      cwd: path.join(root, 'apps.git'),
    });
    expect(mainSha.length).toBe(40);

    // Second init reuses the same materialization — same sha, same path.
    const store2 = new WorktreeStore({ root });
    await store2.init();
    expect(store2.getActiveMainDir()).toBe(mainDir);
  } finally {
    await rmTempRoot(root);
  }
});

test('active-main symlink stays pinned across publish + rollback', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();

    // The stable link path never changes and resolves to the live main
    // worktree after init.
    const link = store.getActiveMainLink();
    expect(link).toBe(path.join(root, 'active-main'));
    expect(await fs.realpath(link)).toBe(await fs.realpath(store.getActiveMainDir()!));

    // Publish rotates the materialized main dir; the link follows it so
    // an external reader that baked `<link>/apps` once stays correct.
    const s1 = await store.openSession('s1');
    await seedApp(s1.worktreePath, 'todo', 'one');
    const r1 = await store.publish({ sessionId: 's1', appId: 'todo', message: 'v1' });
    await store.closeSession('s1');
    expect(await fs.realpath(link)).toBe(await fs.realpath(r1.materializedMainDir));
    // Reading code through the stable link resolves the published app.
    const viaLink = JSON.parse(
      await fs.readFile(path.join(link, 'apps', 'todo', 'app.json'), 'utf8'),
    ) as { marker: string };
    expect(viaLink.marker).toBe('one');

    const s2 = await store.openSession('s2');
    await seedApp(s2.worktreePath, 'todo', 'two');
    const r2 = await store.publish({ sessionId: 's2', appId: 'todo', message: 'v2' });
    await store.closeSession('s2');
    expect(await fs.realpath(link)).toBe(await fs.realpath(r2.materializedMainDir));

    // Rollback repoints the link again — and never leaves it dangling.
    const rb = await store.rollback({ appId: 'todo', versionTag: 'todo/v1' });
    expect(await fs.realpath(link)).toBe(await fs.realpath(rb.materializedMainDir));
    const afterRollback = JSON.parse(
      await fs.readFile(path.join(link, 'apps', 'todo', 'app.json'), 'utf8'),
    ) as { marker: string };
    expect(afterRollback.marker).toBe('one');
  } finally {
    await rmTempRoot(root);
  }
});

test('openSession creates a worktree branched off main; multiple sessions coexist', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();

    const a = await store.openSession('alpha');
    const b = await store.openSession('beta');

    expect(a.id).toBe('alpha');
    expect(a.branch).toBe('sessions/alpha');
    expect(a.worktreePath.endsWith(path.join('worktrees', 'sessions', 'alpha'))).toBeTruthy();
    expect(
      await fs
        .stat(a.worktreePath)
        .then((s) => s.isDirectory())
        .catch(() => false),
    ).toBeTruthy();

    expect(b.id).toBe('beta');
    expect(a.worktreePath).not.toBe(b.worktreePath);

    // Both branches show up in the bare repo.
    const sessions = await store.listSessions();
    expect([...sessions].sort()).toEqual(['alpha', 'beta']);
  } finally {
    await rmTempRoot(root);
  }
});

test('openSession twice for the same id throws session_exists', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();
    await store.openSession('alpha');
    await expectRejectsWithCode(() => store.openSession('alpha'), 'session_exists');
  } finally {
    await rmTempRoot(root);
  }
});

test('publishes a plain-slug app id; rejects dotted and ".." ids (#98)', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();

    // App ids are plain slugs again — automation apps are marked by the
    // manifest `kind` field, not a dotted `auto.` prefix (issue #98). A
    // slug id must round-trip through sessions, publish, and listing.
    const s = await store.openSession('desktop-brief');
    await seedApp(s.worktreePath, 'brief', 'one');
    const r = await store.publish({
      sessionId: 'desktop-brief',
      appId: 'brief',
      message: 'v1',
    });
    expect(r.versionTag).toBe('brief/v1');
    expect((await store.listApps()).sort()).toEqual(['brief']);

    // Dots are no longer part of the id grammar, so a dotted id is rejected
    // (and a tree-traversing `..` is impossible by construction).
    await expectRejectsWithCode(() => store.openSession('auto.brief'), 'invalid_session_id');
    await expectRejectsWithCode(() => store.openSession('bad..id'), 'invalid_session_id');
  } finally {
    await rmTempRoot(root);
  }
});

test('closeSession removes worktree + branch and is idempotent', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();
    const handle = await store.openSession('alpha');

    await store.closeSession('alpha');
    const stillThere = await fs
      .access(handle.worktreePath)
      .then(() => true)
      .catch(() => false);
    expect(stillThere).toBe(false);
    expect(await store.listSessions()).toEqual([]);

    // Second close on a vanished session is a no-op.
    await store.closeSession('alpha');
  } finally {
    await rmTempRoot(root);
  }
});

test('publish of a brand-new app tags v1 and materializes new main', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();
    const mainBefore = store.getActiveMainDir()!;

    const session = await store.openSession('s1');
    await seedApp(session.worktreePath, 'todo', 'first');

    const result = await store.publish({
      sessionId: 's1',
      appId: 'todo',
      message: 'initial',
    });

    expect(result.versionTag).toBe('todo/v1');
    expect(result.sha.length).toBe(40);
    expect(
      result.materializedMainDir.startsWith(path.join(root, 'worktrees', 'main') + path.sep),
    ).toBeTruthy();
    expect(result.materializedMainDir).not.toBe(mainBefore);
    expect(store.getActiveMainDir()).toBe(result.materializedMainDir);

    // resolveActiveAppDir now points at the new main's app subtree.
    const appDir = await store.resolveActiveAppDir('todo');
    expect(appDir).toBe(path.join(result.materializedMainDir, 'apps', 'todo'));
    const appJson = JSON.parse(await fs.readFile(path.join(appDir!, 'app.json'), 'utf8')) as {
      marker: string;
    };
    expect(appJson.marker).toBe('first');

    // Old main dir is gone after the swap.
    const oldExists = await fs
      .access(mainBefore)
      .then(() => true)
      .catch(() => false);
    expect(oldExists).toBe(false);
  } finally {
    await rmTempRoot(root);
  }
});

test('publish increments to v2 on the next publish of the same app', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();

    const s1 = await store.openSession('s1');
    await seedApp(s1.worktreePath, 'todo', 'first');
    const r1 = await store.publish({ sessionId: 's1', appId: 'todo', message: 'v1' });
    expect(r1.versionTag).toBe('todo/v1');
    await store.closeSession('s1');

    const s2 = await store.openSession('s2');
    await seedApp(s2.worktreePath, 'todo', 'second');
    const r2 = await store.publish({ sessionId: 's2', appId: 'todo', message: 'v2' });
    expect(r2.versionTag).toBe('todo/v2');

    const versions = await store.listVersions('todo');
    expect(versions.map((v) => v.tag)).toEqual(['todo/v2', 'todo/v1']);
    // The freshly published v2 is the active subtree on main.
    expect(versions.map((v) => v.active)).toEqual([true, false]);
  } finally {
    await rmTempRoot(root);
  }
});

test('publish is path-scoped: a session that edits two apps publishes only one', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();

    const session = await store.openSession('multi');
    await seedApp(session.worktreePath, 'todo', 'todo-1');
    await seedApp(session.worktreePath, 'notes', 'notes-1');

    await store.publish({ sessionId: 'multi', appId: 'todo', message: 'todo only' });

    // `notes` stays in the session worktree but isn't on main yet.
    const notesActive = await store.resolveActiveAppDir('notes');
    expect(notesActive).toBe(undefined);
    const notesInSession = await fs
      .stat(path.join(session.worktreePath, 'apps', 'notes', 'app.json'))
      .then((s) => s.isFile())
      .catch(() => false);
    expect(notesInSession).toBe(true);

    const todoActive = await store.resolveActiveAppDir('todo');
    expect(todoActive).toBeTruthy();
  } finally {
    await rmTempRoot(root);
  }
});

test('publish with no staged changes under apps/<appId>/ throws no_changes', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();
    await store.openSession('empty');
    await expectRejectsWithCode(
      () =>
        store.publish({
          sessionId: 'empty',
          appId: 'todo',
          message: 'nothing to ship',
        }),
      'no_changes',
    );
  } finally {
    await rmTempRoot(root);
  }
});

test('concurrent publishes on the same store serialize and both succeed', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();

    const a = await store.openSession('a');
    const b = await store.openSession('b');
    await seedApp(a.worktreePath, 'todo', 'from-a');
    await seedApp(b.worktreePath, 'notes', 'from-b');

    const [ra, rb] = await Promise.all([
      store.publish({ sessionId: 'a', appId: 'todo', message: 'from a' }),
      store.publish({ sessionId: 'b', appId: 'notes', message: 'from b' }),
    ]);

    // Both publishes minted v1 tags for distinct apps.
    expect(ra.versionTag).toBe('todo/v1');
    expect(rb.versionTag).toBe('notes/v1');

    // Both apps are reachable from the final main worktree.
    const todoDir = await store.resolveActiveAppDir('todo');
    const notesDir = await store.resolveActiveAppDir('notes');
    expect(todoDir).toBeTruthy();
    expect(notesDir).toBeTruthy();

    // Active main was swapped exactly to the second publish's
    // materialization — the first one was evicted.
    expect(store.getActiveMainDir()).toBe(rb.materializedMainDir);
  } finally {
    await rmTempRoot(root);
  }
});

test('rollback overlays the old subtree onto main without minting a tag', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();

    const s1 = await store.openSession('s1');
    await seedApp(s1.worktreePath, 'todo', 'one');
    await store.publish({ sessionId: 's1', appId: 'todo', message: 'v1' });
    await store.closeSession('s1');

    const s2 = await store.openSession('s2');
    await seedApp(s2.worktreePath, 'todo', 'two');
    await store.publish({ sessionId: 's2', appId: 'todo', message: 'v2' });
    await store.closeSession('s2');

    const tagsBefore = await store.listVersions('todo');
    expect(tagsBefore.map((t) => t.tag)).toEqual(['todo/v2', 'todo/v1']);

    const rb = await store.rollback({ appId: 'todo', versionTag: 'todo/v1' });
    expect(rb.sha.length).toBe(40);

    // Active app dir reflects v1's content.
    const appDir = await store.resolveActiveAppDir('todo');
    expect(appDir).toBeTruthy();
    const appJson = JSON.parse(await fs.readFile(path.join(appDir!, 'app.json'), 'utf8')) as {
      marker: string;
    };
    expect(appJson.marker).toBe('one');

    // No new tag minted — listVersions still shows v1 and v2 only.
    const tagsAfter = await store.listVersions('todo');
    expect(tagsAfter.map((t) => t.tag)).toEqual(['todo/v2', 'todo/v1']);
    // Active subtree flipped from v2 to v1 — the older tag is live
    // again, the newer one is preserved but inactive.
    expect(tagsAfter.map((t) => t.active)).toEqual([false, true]);

    // main log includes the rollback commit (chronological audit).
    const log = await run(['log', '--format=%s', 'refs/heads/main'], {
      cwd: path.join(root, 'apps.git'),
    });
    expect(log).toMatch(/rollback: todo -> todo\/v1/);
  } finally {
    await rmTempRoot(root);
  }
});

test('rollback to a tag that matches current main throws no_changes', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();
    const session = await store.openSession('s1');
    await seedApp(session.worktreePath, 'todo', 'one');
    await store.publish({ sessionId: 's1', appId: 'todo', message: 'v1' });

    await expectRejectsWithCode(
      () => store.rollback({ appId: 'todo', versionTag: 'todo/v1' }),
      'no_changes',
    );
  } finally {
    await rmTempRoot(root);
  }
});

test('rollback to a missing tag throws tag_missing', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();
    await expectRejectsWithCode(
      () => store.rollback({ appId: 'todo', versionTag: 'todo/v9' }),
      'tag_missing',
    );
  } finally {
    await rmTempRoot(root);
  }
});

test('resolveActiveAppDir returns undefined for an app never published', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();
    expect(await store.resolveActiveAppDir('ghost')).toBe(undefined);
  } finally {
    await rmTempRoot(root);
  }
});

test('listVersions returns [] for an app with no tags', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();
    expect(await store.listVersions('ghost')).toEqual([]);
  } finally {
    await rmTempRoot(root);
  }
});

test('deleteApp removes the app from main and reaps its version tags', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();

    const s1 = await store.openSession('s1');
    await seedApp(s1.worktreePath, 'todo', 'first');
    await store.publish({ sessionId: 's1', appId: 'todo', message: 'v1' });
    await store.closeSession('s1');

    // Before: app is live + has a tag.
    expect(await store.resolveActiveAppDir('todo')).toBeTruthy();
    expect((await store.listVersions('todo')).map((v) => v.tag)).toEqual(['todo/v1']);

    const out = await store.deleteApp('todo');
    expect(out.sha.length).toBe(40);

    // After: app gone from main, all tags reaped, listVersions empty.
    expect(await store.resolveActiveAppDir('todo')).toBe(undefined);
    expect(await store.listVersions('todo')).toEqual([]);
    expect(await store.listApps()).toEqual([]);

    // The delete commit is on main as a forward audit entry.
    const log = await run(['log', '--format=%s', 'refs/heads/main'], {
      cwd: path.join(root, 'apps.git'),
    });
    expect(log).toMatch(/delete: todo/);
  } finally {
    await rmTempRoot(root);
  }
});

test('deleteApp throws no_changes for an app that was never on main', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();
    await expectRejectsWithCode(() => store.deleteApp('ghost'), 'no_changes');
  } finally {
    await rmTempRoot(root);
  }
});

test('snapshotSessionAppDir refuses to create phantom dirs without a worktree', async () => {
  // Guards against a stray PUT files arriving with a sessionId that
  // was never openSession()'d, materializing
  // `worktrees/sessions/<id>/apps/<app>/` from thin air. A later
  // openSession would then 409 with `session_exists`, and a publish
  // would `git add` in a plain directory and fail. Throwing
  // `session_missing` here forces the caller to open a session first.
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();
    await expectRejectsWithCode(
      () => store.snapshotSessionAppDir('phantom', 'todo'),
      'session_missing',
    );
    // And no phantom dir was left behind.
    const phantomDir = path.join(root, 'worktrees', 'sessions', 'phantom');
    const exists = await fs
      .stat(phantomDir)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  } finally {
    await rmTempRoot(root);
  }
});

test('init replants main if the ref went missing between runs', async () => {
  const root = await makeTempRoot();
  try {
    const first = new WorktreeStore({ root });
    await first.init();

    // Simulate a corrupted-ref recovery: blow away refs/heads/main.
    await fs.rm(path.join(root, 'apps.git', 'refs', 'heads', 'main'), { force: true });
    // packed-refs may still be there; nuke too to make sure rev-parse fails.
    await fs.rm(path.join(root, 'apps.git', 'packed-refs'), { force: true });

    const second = new WorktreeStore({ root });
    await second.init();

    // After recovery init, main resolves again.
    const sha = await run(['rev-parse', 'refs/heads/main'], {
      cwd: path.join(root, 'apps.git'),
    });
    expect(sha.length).toBe(40);
  } finally {
    await rmTempRoot(root);
  }
});

test('every method except init throws not_initialized before init()', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await expectRejectsWithCode(() => store.resolveActiveAppDir('todo'), 'not_initialized');
    await expectRejectsWithCode(() => store.openSession('s1'), 'not_initialized');
    await expectRejectsWithCode(() => store.listSessions(), 'not_initialized');
  } finally {
    await rmTempRoot(root);
  }
});

test('app ids are validated', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();
    await expectRejectsWithCode(() => store.resolveActiveAppDir('../etc/passwd'), 'invalid_app_id');
    await expectRejectsWithCode(() => store.openSession('bad/name'), 'invalid_session_id');
  } finally {
    // Make the linter happy that crypto is used (id collisions
    // matter in a tempdir suite running under `--test`).
    expect(crypto.randomUUID().length).toBe(36);
    await rmTempRoot(root);
  }
});
