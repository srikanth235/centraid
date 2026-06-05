// governance: allow-repo-hygiene file-size-limit unit tests for one module — splitting by topic would scatter the shared helpers
import { test } from 'vitest';
import assert from 'node:assert/strict';
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
    assert.ok(mainDir, 'expected an active main dir after init');
    assert.ok(
      mainDir!.startsWith(path.join(root, 'worktrees', 'main') + path.sep),
      `expected main dir under worktrees/main/, got ${mainDir}`,
    );

    // Bare repo exists with the `main` ref planted.
    const head = await fs.readFile(path.join(root, 'apps.git', 'HEAD'), 'utf8');
    assert.match(head, /refs\/heads\/main/);
    const mainSha = await run(['rev-parse', 'refs/heads/main'], {
      cwd: path.join(root, 'apps.git'),
    });
    assert.equal(mainSha.length, 40);

    // Second init reuses the same materialization — same sha, same path.
    const store2 = new WorktreeStore({ root });
    await store2.init();
    assert.equal(store2.getActiveMainDir(), mainDir);
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
    assert.equal(link, path.join(root, 'active-main'));
    assert.equal(await fs.realpath(link), await fs.realpath(store.getActiveMainDir()!));

    // Publish rotates the materialized main dir; the link follows it so
    // an external reader that baked `<link>/apps` once stays correct.
    const s1 = await store.openSession('s1');
    await seedApp(s1.worktreePath, 'todo', 'one');
    const r1 = await store.publish({ sessionId: 's1', appId: 'todo', message: 'v1' });
    await store.closeSession('s1');
    assert.equal(await fs.realpath(link), await fs.realpath(r1.materializedMainDir));
    // Reading code through the stable link resolves the published app.
    const viaLink = JSON.parse(
      await fs.readFile(path.join(link, 'apps', 'todo', 'app.json'), 'utf8'),
    ) as { marker: string };
    assert.equal(viaLink.marker, 'one');

    const s2 = await store.openSession('s2');
    await seedApp(s2.worktreePath, 'todo', 'two');
    const r2 = await store.publish({ sessionId: 's2', appId: 'todo', message: 'v2' });
    await store.closeSession('s2');
    assert.equal(await fs.realpath(link), await fs.realpath(r2.materializedMainDir));

    // Rollback repoints the link again — and never leaves it dangling.
    const rb = await store.rollback({ appId: 'todo', versionTag: 'todo/v1' });
    assert.equal(await fs.realpath(link), await fs.realpath(rb.materializedMainDir));
    const afterRollback = JSON.parse(
      await fs.readFile(path.join(link, 'apps', 'todo', 'app.json'), 'utf8'),
    ) as { marker: string };
    assert.equal(afterRollback.marker, 'one');
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

    assert.equal(a.id, 'alpha');
    assert.equal(a.branch, 'sessions/alpha');
    assert.ok(a.worktreePath.endsWith(path.join('worktrees', 'sessions', 'alpha')));
    assert.ok(
      await fs
        .stat(a.worktreePath)
        .then((s) => s.isDirectory())
        .catch(() => false),
    );

    assert.equal(b.id, 'beta');
    assert.notEqual(a.worktreePath, b.worktreePath);

    // Both branches show up in the bare repo.
    const sessions = await store.listSessions();
    assert.deepEqual([...sessions].sort(), ['alpha', 'beta']);
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
    await assert.rejects(
      () => store.openSession('alpha'),
      (err: unknown) => err instanceof WorktreeStoreError && err.code === 'session_exists',
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
    assert.equal(r.versionTag, 'brief/v1');
    assert.deepEqual((await store.listApps()).sort(), ['brief']);

    // Dots are no longer part of the id grammar, so a dotted id is rejected
    // (and a tree-traversing `..` is impossible by construction).
    await assert.rejects(
      () => store.openSession('auto.brief'),
      (err: unknown) => err instanceof WorktreeStoreError && err.code === 'invalid_session_id',
    );
    await assert.rejects(
      () => store.openSession('bad..id'),
      (err: unknown) => err instanceof WorktreeStoreError && err.code === 'invalid_session_id',
    );
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
    assert.equal(stillThere, false, 'expected session worktree dir to be gone');
    assert.deepEqual(await store.listSessions(), []);

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

    assert.equal(result.versionTag, 'todo/v1');
    assert.equal(result.sha.length, 40);
    assert.ok(
      result.materializedMainDir.startsWith(path.join(root, 'worktrees', 'main') + path.sep),
    );
    assert.notEqual(result.materializedMainDir, mainBefore);
    assert.equal(store.getActiveMainDir(), result.materializedMainDir);

    // resolveActiveAppDir now points at the new main's app subtree.
    const appDir = await store.resolveActiveAppDir('todo');
    assert.equal(appDir, path.join(result.materializedMainDir, 'apps', 'todo'));
    const appJson = JSON.parse(await fs.readFile(path.join(appDir!, 'app.json'), 'utf8')) as {
      marker: string;
    };
    assert.equal(appJson.marker, 'first');

    // Old main dir is gone after the swap.
    const oldExists = await fs
      .access(mainBefore)
      .then(() => true)
      .catch(() => false);
    assert.equal(oldExists, false, 'expected previous main materialization to be evicted');
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
    assert.equal(r1.versionTag, 'todo/v1');
    await store.closeSession('s1');

    const s2 = await store.openSession('s2');
    await seedApp(s2.worktreePath, 'todo', 'second');
    const r2 = await store.publish({ sessionId: 's2', appId: 'todo', message: 'v2' });
    assert.equal(r2.versionTag, 'todo/v2');

    const versions = await store.listVersions('todo');
    assert.deepEqual(
      versions.map((v) => v.tag),
      ['todo/v2', 'todo/v1'],
    );
    // The freshly published v2 is the active subtree on main.
    assert.deepEqual(
      versions.map((v) => v.active),
      [true, false],
    );
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
    assert.equal(notesActive, undefined);
    const notesInSession = await fs
      .stat(path.join(session.worktreePath, 'apps', 'notes', 'app.json'))
      .then((s) => s.isFile())
      .catch(() => false);
    assert.equal(notesInSession, true);

    const todoActive = await store.resolveActiveAppDir('todo');
    assert.ok(todoActive);
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
    await assert.rejects(
      () =>
        store.publish({
          sessionId: 'empty',
          appId: 'todo',
          message: 'nothing to ship',
        }),
      (err: unknown) => err instanceof WorktreeStoreError && err.code === 'no_changes',
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
    assert.equal(ra.versionTag, 'todo/v1');
    assert.equal(rb.versionTag, 'notes/v1');

    // Both apps are reachable from the final main worktree.
    const todoDir = await store.resolveActiveAppDir('todo');
    const notesDir = await store.resolveActiveAppDir('notes');
    assert.ok(todoDir);
    assert.ok(notesDir);

    // Active main was swapped exactly to the second publish's
    // materialization — the first one was evicted.
    assert.equal(store.getActiveMainDir(), rb.materializedMainDir);
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
    assert.deepEqual(
      tagsBefore.map((t) => t.tag),
      ['todo/v2', 'todo/v1'],
    );

    const rb = await store.rollback({ appId: 'todo', versionTag: 'todo/v1' });
    assert.equal(rb.sha.length, 40);

    // Active app dir reflects v1's content.
    const appDir = await store.resolveActiveAppDir('todo');
    assert.ok(appDir);
    const appJson = JSON.parse(await fs.readFile(path.join(appDir!, 'app.json'), 'utf8')) as {
      marker: string;
    };
    assert.equal(appJson.marker, 'one');

    // No new tag minted — listVersions still shows v1 and v2 only.
    const tagsAfter = await store.listVersions('todo');
    assert.deepEqual(
      tagsAfter.map((t) => t.tag),
      ['todo/v2', 'todo/v1'],
    );
    // Active subtree flipped from v2 to v1 — the older tag is live
    // again, the newer one is preserved but inactive.
    assert.deepEqual(
      tagsAfter.map((t) => t.active),
      [false, true],
    );

    // main log includes the rollback commit (chronological audit).
    const log = await run(['log', '--format=%s', 'refs/heads/main'], {
      cwd: path.join(root, 'apps.git'),
    });
    assert.match(log, /rollback: todo -> todo\/v1/);
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

    await assert.rejects(
      () => store.rollback({ appId: 'todo', versionTag: 'todo/v1' }),
      (err: unknown) => err instanceof WorktreeStoreError && err.code === 'no_changes',
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
    await assert.rejects(
      () => store.rollback({ appId: 'todo', versionTag: 'todo/v9' }),
      (err: unknown) => err instanceof WorktreeStoreError && err.code === 'tag_missing',
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
    assert.equal(await store.resolveActiveAppDir('ghost'), undefined);
  } finally {
    await rmTempRoot(root);
  }
});

test('listVersions returns [] for an app with no tags', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();
    assert.deepEqual(await store.listVersions('ghost'), []);
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
    assert.ok(await store.resolveActiveAppDir('todo'));
    assert.deepEqual(
      (await store.listVersions('todo')).map((v) => v.tag),
      ['todo/v1'],
    );

    const out = await store.deleteApp('todo');
    assert.equal(out.sha.length, 40);

    // After: app gone from main, all tags reaped, listVersions empty.
    assert.equal(await store.resolveActiveAppDir('todo'), undefined);
    assert.deepEqual(await store.listVersions('todo'), []);
    assert.deepEqual(await store.listApps(), []);

    // The delete commit is on main as a forward audit entry.
    const log = await run(['log', '--format=%s', 'refs/heads/main'], {
      cwd: path.join(root, 'apps.git'),
    });
    assert.match(log, /delete: todo/);
  } finally {
    await rmTempRoot(root);
  }
});

test('deleteApp throws no_changes for an app that was never on main', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();
    await assert.rejects(
      () => store.deleteApp('ghost'),
      (err: unknown) => err instanceof WorktreeStoreError && err.code === 'no_changes',
    );
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
    await assert.rejects(
      () => store.snapshotSessionAppDir('phantom', 'todo'),
      (err: unknown) => err instanceof WorktreeStoreError && err.code === 'session_missing',
    );
    // And no phantom dir was left behind.
    const phantomDir = path.join(root, 'worktrees', 'sessions', 'phantom');
    const exists = await fs
      .stat(phantomDir)
      .then(() => true)
      .catch(() => false);
    assert.equal(exists, false);
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
    assert.equal(sha.length, 40);
  } finally {
    await rmTempRoot(root);
  }
});

test('every method except init throws not_initialized before init()', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await assert.rejects(
      () => store.resolveActiveAppDir('todo'),
      (err: unknown) => err instanceof WorktreeStoreError && err.code === 'not_initialized',
    );
    await assert.rejects(
      () => store.openSession('s1'),
      (err: unknown) => err instanceof WorktreeStoreError && err.code === 'not_initialized',
    );
    await assert.rejects(
      () => store.listSessions(),
      (err: unknown) => err instanceof WorktreeStoreError && err.code === 'not_initialized',
    );
  } finally {
    await rmTempRoot(root);
  }
});

test('app ids are validated', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();
    await assert.rejects(
      () => store.resolveActiveAppDir('../etc/passwd'),
      (err: unknown) => err instanceof WorktreeStoreError && err.code === 'invalid_app_id',
    );
    await assert.rejects(
      () => store.openSession('bad/name'),
      (err: unknown) => err instanceof WorktreeStoreError && err.code === 'invalid_session_id',
    );
  } finally {
    // Make the linter happy that crypto is used (id collisions
    // matter in a tempdir suite running under `--test`).
    assert.equal(crypto.randomUUID().length, 36);
    await rmTempRoot(root);
  }
});

test('draft data.sqlite is gitignored — never staged by publish (#144)', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();
    const bare = path.join(root, 'apps.git');

    // The draft-data `.gitignore` is on `main` with all three patterns.
    const ignore = await run(['show', 'refs/heads/main:.gitignore'], { cwd: bare });
    assert.match(ignore, /^data\.sqlite$/m);
    assert.match(ignore, /^data\.sqlite-wal$/m);
    assert.match(ignore, /^data\.sqlite-shm$/m);

    // A session branched off main inherits it.
    const handle = await store.openSession('s1');
    const sessionIgnore = await fs.readFile(path.join(handle.worktreePath, '.gitignore'), 'utf8');
    assert.match(sessionIgnore, /data\.sqlite/);

    // Stage real code plus a draft data.sqlite (+ WAL/SHM sidecars), publish.
    await seedApp(handle.worktreePath, 'todo', 'v1');
    const appDir = path.join(handle.worktreePath, 'apps', 'todo');
    await fs.writeFile(path.join(appDir, 'data.sqlite'), 'draft-rows');
    await fs.writeFile(path.join(appDir, 'data.sqlite-wal'), 'wal');
    await fs.writeFile(path.join(appDir, 'data.sqlite-shm'), 'shm');
    await store.publish({ sessionId: 's1', appId: 'todo', message: 'first' });

    // The published main subtree carries the code but none of the data files.
    const tree = await run(['ls-tree', '-r', '--name-only', 'refs/heads/main:apps/todo'], {
      cwd: bare,
    });
    const names = tree.split('\n').filter(Boolean);
    assert.ok(names.includes('app.json'), `expected app.json, got: ${tree}`);
    assert.ok(names.includes('actions/noop.js'), `expected actions/noop.js, got: ${tree}`);
    assert.ok(
      !names.some((n) => n.startsWith('data.sqlite')),
      `draft data leaked into the published tree: ${tree}`,
    );
  } finally {
    await rmTempRoot(root);
  }
});

test('ensureGitignore self-heals a .gitignore missing the data patterns (#144)', async () => {
  const root = await makeTempRoot();
  try {
    const store = new WorktreeStore({ root });
    await store.init();
    const bare = store.bareRepoDir;

    // Downgrade main's .gitignore to one WITHOUT the draft-data patterns,
    // simulating an older store / a template that committed its own ignore.
    const wt = path.join(root, 'worktrees', '_downgrade');
    await run(['worktree', 'add', '--detach', wt, 'refs/heads/main'], { cwd: bare });
    await fs.writeFile(path.join(wt, '.gitignore'), 'node_modules\n');
    await run(['add', '--', '.gitignore'], { cwd: wt });
    await run(['commit', '-m', 'downgrade gitignore'], { cwd: wt });
    const sha = await run(['rev-parse', 'HEAD'], { cwd: wt });
    await run(['update-ref', 'refs/heads/main', sha], { cwd: bare });
    await run(['worktree', 'remove', '--force', wt], { cwd: bare });

    // A fresh boot must merge the missing patterns back in — existence of a
    // .gitignore is not treated as success — while preserving node_modules.
    await new WorktreeStore({ root }).init();
    const gi = await run(['show', 'refs/heads/main:.gitignore'], { cwd: bare });
    assert.match(gi, /node_modules/, 'existing patterns preserved');
    for (const p of ['data.sqlite', 'data.sqlite-wal', 'data.sqlite-shm']) {
      assert.ok(gi.includes(p), `missing pattern ${p} should be merged in: ${gi}`);
    }
  } finally {
    await rmTempRoot(root);
  }
});
