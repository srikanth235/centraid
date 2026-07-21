// Coverage for launch planning: native vs adapter-backed spawns, the per-kind
// launch env, and the root-bypass opt-in notice.

import { afterEach, expect, test } from 'vitest';
import type { TurnStreamEvent } from '@centraid/app-engine';
import { planLaunch } from './launch.ts';
import type { AcpTurnConfig } from './types.ts';

const CLAUDE_ADAPTER = '@agentclientprotocol/claude-agent-acp';

const originalGeteuid = process.geteuid;
afterEach(() => {
  // Restore the real uid probe after any test that stubbed root.
  process.geteuid = originalGeteuid;
});

test('native kind throws an actionable error when no binary is configured', () => {
  const config: AcpTurnConfig = { kind: 'acp', acpArgs: [] };
  expect(() => planLaunch(config, undefined, [])).toThrow(/No binary configured/);
});

test('native kind spawns the configured bin with acpArgs + extraArgs and per-kind env', () => {
  const config: AcpTurnConfig = {
    kind: 'gemini',
    acpArgs: ['--acp'],
    binPath: '/usr/local/bin/gemini',
    extraArgs: ['--verbose'],
    env: { GEMINI_HEADLESS: '1' },
  };
  const plan = planLaunch(config, '/opt/centraid/bin', []);
  expect(plan.bin).toBe('/usr/local/bin/gemini');
  expect(plan.args).toEqual(['--acp', '--verbose']);
  // The per-kind env var is applied on top of the sanitized spawn env…
  expect(plan.env.GEMINI_HEADLESS).toBe('1');
  // …and extraPath is prepended to PATH.
  expect(plan.env.PATH?.startsWith('/opt/centraid/bin')).toBe(true);
});

test('native kind falls back to defaultBin when no binPath is set', () => {
  const config: AcpTurnConfig = {
    kind: 'gemini',
    acpArgs: [],
    defaultBin: '/usr/bin/gemini',
  };
  const plan = planLaunch(config, undefined, []);
  expect(plan.bin).toBe('/usr/bin/gemini');
  expect(plan.args).toEqual([]);
});

test('adapter-backed kind spawns node with the resolved adapter entry and binPath env var', () => {
  const config: AcpTurnConfig = {
    kind: 'claude-code',
    acpArgs: [],
    binPath: '/home/me/.local/bin/claude',
    extraArgs: ['--foo'],
    env: { AUGMENT_DISABLE_AUTO_UPDATE: '1' },
    adapter: {
      packageName: CLAUDE_ADAPTER,
      binPathEnvVar: 'CLAUDE_CODE_EXECUTABLE',
    },
  };
  const plan = planLaunch(config, undefined, []);
  expect(plan.bin).toBe(process.execPath);
  expect(plan.args[0]).toMatch(/claude-agent-acp/);
  expect(plan.args.at(-1)).toBe('--foo');
  // binPath is redirected into the adapter's "real CLI" env var.
  expect(plan.env.CLAUDE_CODE_EXECUTABLE).toBe('/home/me/.local/bin/claude');
  expect(plan.env.AUGMENT_DISABLE_AUTO_UPDATE).toBe('1');
});

test('adapter-backed kind: root triggers the IS_SANDBOX bypass opt-in with a notice', () => {
  process.geteuid = () => 0; // pretend we are root
  const notices: TurnStreamEvent[] = [];
  const config: AcpTurnConfig = {
    kind: 'claude-code',
    acpArgs: [],
    adapter: {
      packageName: CLAUDE_ADAPTER,
      sessionModeId: 'bypassPermissions',
      bypassNeedsSandboxWhenRoot: true,
    },
  };
  const plan = planLaunch(config, undefined, notices);
  expect(plan.env.IS_SANDBOX).toBe('1');
  expect(notices).toHaveLength(1);
  expect(notices[0]?.type).toBe('notice');
  expect(notices[0] && notices[0].type === 'notice' && notices[0].code).toBe('root_bypass_optin');
});

test('adapter-backed kind: non-root does not force IS_SANDBOX or push a notice', () => {
  process.geteuid = () => 501; // an ordinary user
  const notices: TurnStreamEvent[] = [];
  const config: AcpTurnConfig = {
    kind: 'claude-code',
    acpArgs: [],
    adapter: {
      packageName: CLAUDE_ADAPTER,
      sessionModeId: 'bypassPermissions',
      bypassNeedsSandboxWhenRoot: true,
    },
  };
  const plan = planLaunch(config, undefined, notices);
  expect(plan.env.IS_SANDBOX).toBeUndefined();
  expect(notices).toEqual([]);
});
