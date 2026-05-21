import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OsSchedulerHost } from './os-scheduler-host.js';
import type { ExecShell } from './os-scheduler.js';
import type { AutomationRow } from '@centraid/runtime-core';

interface ShellCall {
  command: string;
  args: string[];
}

function setup(): {
  artifactRoot: string;
  shellCalls: ShellCall[];
  execShell: ExecShell;
  host: OsSchedulerHost;
} {
  const artifactRoot = mkdtempSync(path.join(tmpdir(), 'centraid-os-host-'));
  const shellCalls: ShellCall[] = [];
  const execShell: ExecShell = async (command, args) => {
    shellCalls.push({ command, args });
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const host = new OsSchedulerHost({
    resolveAppDir: (appId) => `/persistent/apps/${appId}`,
    centraidBin: '/usr/local/bin/centraid',
    automationDbPath: '/persistent/centraid-activity.sqlite',
    runner: 'codex',
    os: { execShell, platform: 'darwin', artifactRoot },
  });
  return { artifactRoot, shellCalls, execShell, host };
}

function row(overrides: Partial<AutomationRow> = {}): AutomationRow {
  return {
    originAppId: 'todos',
    name: 'daily-digest',
    prompt: 'do the thing',
    cronExpr: '0 17 * * 1-5',
    enabled: true,
    manifest: {
      prompt: 'do the thing',
      trigger: { kind: 'cron', expr: '0 17 * * 1-5' },
      action: 'daily-digest.js',
      requires: { model: 'anthropic/claude-3-5-sonnet' },
      generated: { by: 'template', at: '2026-05-19T00:00:00Z' },
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('OsSchedulerHost', () => {
  it('register installs a launchd plist with the persistent app root as cwd', async () => {
    const ctx = setup();
    await ctx.host.register(row());
    const artifactPath = path.join(ctx.artifactRoot, 'com.centraid.todos.daily-digest.plist');
    const plist = await fs.readFile(artifactPath, 'utf8');
    assert.match(
      plist,
      /<key>WorkingDirectory<\/key>\s*<string>\/persistent\/apps\/todos<\/string>/,
    );
    assert.match(plist, /run-automation/);
  });

  it('register with enabled=false unregisters instead', async () => {
    const ctx = setup();
    await ctx.host.register(row()); // first install
    const artifactPath = path.join(ctx.artifactRoot, 'com.centraid.todos.daily-digest.plist');
    await fs.access(artifactPath); // present
    await ctx.host.register(row({ enabled: false }));
    let stillPresent = true;
    try {
      await fs.access(artifactPath);
    } catch {
      stillPresent = false;
    }
    assert.equal(stillPresent, false, 'plist must be removed when enabled=false');
  });

  it('unregister removes the artifact and is idempotent on second call', async () => {
    const ctx = setup();
    await ctx.host.register(row());
    await ctx.host.unregister('todos', 'daily-digest');
    await ctx.host.unregister('todos', 'daily-digest'); // no throw
  });

  it('list reports the host-side label for installed entries', async () => {
    const ctx = setup();
    await ctx.host.register(row());
    await ctx.host.register(row({ name: 'weekly-recap', cronExpr: '0 20 * * 0' }));
    const names = await ctx.host.list();
    assert.deepEqual([...names].sort(), [
      'com.centraid.todos.daily-digest',
      'com.centraid.todos.weekly-recap',
    ]);
  });

  it('reconcile installs missing, updates existing, removes orphans', async () => {
    const ctx = setup();
    // Pre-state: one installed entry that's no longer desired.
    await ctx.host.register(row({ name: 'old-one' }));

    const desired: AutomationRow[] = [
      row(), // daily-digest — new
      row({ name: 'old-one', cronExpr: '0 6 * * *' }), // existing — schedule changed
      row({ name: 'paused-one', enabled: false }), // disabled — should not be installed
    ];
    const result = await ctx.host.reconcile(desired);

    assert.deepEqual([...result.added].sort(), ['com.centraid.todos.daily-digest']);
    assert.deepEqual([...result.updated].sort(), ['com.centraid.todos.old-one']);
    assert.deepEqual(result.removed, []);

    // The disabled row should have produced no artifact.
    const finalList = await ctx.host.list();
    assert.equal(finalList.includes('com.centraid.todos.paused-one'), false);
  });

  it('reconcile removes installed entries that are absent from desired', async () => {
    const ctx = setup();
    await ctx.host.register(row({ name: 'zombie' }));
    const result = await ctx.host.reconcile([]);
    assert.deepEqual(result.removed, ['com.centraid.todos.zombie']);
    const finalList = await ctx.host.list();
    assert.equal(finalList.length, 0);
  });

  it('reconcile with scope.appId only touches that app — other apps survive', async () => {
    // Two apps, one automation each, both installed.
    const ctx = setup();
    await ctx.host.register(row({ originAppId: 'todos', name: 'daily-digest' }));
    await ctx.host.register(
      row({ originAppId: 'journal', name: 'weekly-recap', cronExpr: '0 20 * * 0' }),
    );
    const before = await ctx.host.list();
    assert.deepEqual([...before].sort(), [
      'com.centraid.journal.weekly-recap',
      'com.centraid.todos.daily-digest',
    ]);

    // Scoped reconcile against todos' rows. The desired set only
    // contains the existing todos entry, so journal's row appears
    // "absent" — but because we scope, journal's entry must survive.
    const result = await ctx.host.reconcile([row({ originAppId: 'todos', name: 'daily-digest' })], {
      scope: { appId: 'todos' },
    });
    assert.deepEqual(result.added, []);
    assert.deepEqual([...result.updated].sort(), ['com.centraid.todos.daily-digest']);
    assert.deepEqual(result.removed, []);
    const afterUpdate = await ctx.host.list();
    assert.deepEqual([...afterUpdate].sort(), [
      'com.centraid.journal.weekly-recap',
      'com.centraid.todos.daily-digest',
    ]);

    // Scoped reconcile against an empty todos desired set (the
    // deregister path). Without scoping this would wipe both apps'
    // entries; with scope it must only remove todos.
    const wipeTodos = await ctx.host.reconcile([], { scope: { appId: 'todos' } });
    assert.deepEqual(wipeTodos.removed, ['com.centraid.todos.daily-digest']);
    const afterWipe = await ctx.host.list();
    assert.deepEqual([...afterWipe], ['com.centraid.journal.weekly-recap']);
  });

  it('reconcile with scope ignores desired rows for other apps', async () => {
    // Defense in depth: even if a caller hands us a cross-app row by
    // mistake, a scoped reconcile must not register it.
    const ctx = setup();
    await ctx.host.reconcile(
      [
        row({ originAppId: 'todos', name: 'daily-digest' }),
        row({ originAppId: 'journal', name: 'leak', cronExpr: '0 9 * * *' }),
      ],
      { scope: { appId: 'todos' } },
    );
    const installed = await ctx.host.list();
    assert.deepEqual([...installed], ['com.centraid.todos.daily-digest']);
  });
});
