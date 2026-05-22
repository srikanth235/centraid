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
    workdir: '/persistent/work',
    centraidBin: '/usr/local/bin/centraid',
    automationDbPath: '/persistent/centraid-activity.sqlite',
    appsDir: '/persistent/apps',
    runner: 'codex',
    os: { execShell, platform: 'darwin', artifactRoot },
  });
  return { artifactRoot, shellCalls, execShell, host };
}

/** The owning app id every test row shares — `<ownerApp>/<id>` is the handle. */
const OWNER = 'svc';

function row(
  overrides: { id?: string; name?: string; cronExpr?: string; enabled?: boolean } = {},
): AutomationRow {
  const id = overrides.id ?? 'auto-1';
  const name = overrides.name ?? 'daily-digest';
  const enabled = overrides.enabled ?? true;
  const triggers = [{ kind: 'cron' as const, expr: overrides.cronExpr ?? '0 17 * * 1-5' }];
  return {
    id,
    dir: `/persistent/apps/${OWNER}/automations/${id}`,
    name,
    triggers,
    enabled,
    ownerApp: OWNER,
    ref: `${OWNER}/${id}`,
    manifest: {
      name,
      version: '0.1.0',
      enabled,
      prompt: 'do the thing',
      triggers,
      requires: { model: 'anthropic/claude-3-5-sonnet' },
      history: { keep: { count: 100 } },
      generated: { by: 'template', at: '2026-05-19T00:00:00Z' },
    },
  };
}

describe('OsSchedulerHost', () => {
  it('register installs a launchd plist with the workdir as cwd', async () => {
    const ctx = setup();
    await ctx.host.register(row());
    const artifactPath = path.join(ctx.artifactRoot, 'com.centraid.svc_sauto-1.plist');
    const plist = await fs.readFile(artifactPath, 'utf8');
    assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/persistent\/work<\/string>/);
    assert.match(plist, /run-automation/);
    assert.match(plist, /<string>svc\/auto-1<\/string>/);
  });

  it('register with enabled=false unregisters instead', async () => {
    const ctx = setup();
    await ctx.host.register(row()); // first install
    const artifactPath = path.join(ctx.artifactRoot, 'com.centraid.svc_sauto-1.plist');
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
    await ctx.host.unregister('svc/auto-1');
    await ctx.host.unregister('svc/auto-1'); // no throw
  });

  it('list reports the automation handle for installed entries', async () => {
    const ctx = setup();
    await ctx.host.register(row());
    await ctx.host.register(row({ id: 'auto-2', name: 'weekly-recap', cronExpr: '0 20 * * 0' }));
    const names = await ctx.host.list();
    assert.deepEqual([...names].sort(), ['svc/auto-1', 'svc/auto-2']);
  });

  it('reconcile installs missing, updates existing, removes orphans', async () => {
    const ctx = setup();
    // Pre-state: one installed entry that's no longer desired.
    await ctx.host.register(row({ id: 'auto-old', name: 'old-one' }));

    const desired: AutomationRow[] = [
      row(), // svc/auto-1 — new
      row({ id: 'auto-old', name: 'old-one', cronExpr: '0 6 * * *' }), // existing — changed
      row({ id: 'auto-paused', name: 'paused-one', enabled: false }), // disabled — not installed
    ];
    const result = await ctx.host.reconcile(desired);

    assert.deepEqual([...result.added].sort(), ['com.centraid.svc_sauto-1']);
    assert.deepEqual([...result.updated].sort(), ['com.centraid.svc_sauto-old']);
    assert.deepEqual(result.removed, []);

    // The disabled row should have produced no artifact.
    const finalList = await ctx.host.list();
    assert.equal(finalList.includes('svc/auto-paused'), false);
  });

  it('reconcile removes installed entries that are absent from desired', async () => {
    const ctx = setup();
    await ctx.host.register(row({ id: 'auto-zombie', name: 'zombie' }));
    const result = await ctx.host.reconcile([]);
    assert.deepEqual(result.removed, ['com.centraid.svc_sauto-zombie']);
    const finalList = await ctx.host.list();
    assert.equal(finalList.length, 0);
  });

  it('reconcile updates an existing entry without removing unrelated ones', async () => {
    const ctx = setup();
    await ctx.host.register(row({ id: 'auto-1', name: 'daily-digest' }));
    await ctx.host.register(row({ id: 'auto-2', name: 'weekly-recap', cronExpr: '0 20 * * 0' }));

    // Reconcile with the full desired set — both survive, both updated.
    const result = await ctx.host.reconcile([
      row({ id: 'auto-1', name: 'daily-digest' }),
      row({ id: 'auto-2', name: 'weekly-recap', cronExpr: '0 20 * * 0' }),
    ]);
    assert.deepEqual(result.added, []);
    assert.deepEqual([...result.updated].sort(), [
      'com.centraid.svc_sauto-1',
      'com.centraid.svc_sauto-2',
    ]);
    assert.deepEqual(result.removed, []);
    const after = await ctx.host.list();
    assert.deepEqual([...after].sort(), ['svc/auto-1', 'svc/auto-2']);
  });
});
