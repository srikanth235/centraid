import { describe, expect, it } from 'vitest';
import { resolveGatewayRunnerPrefs } from './runner-prefs.js';

describe('resolveGatewayRunnerPrefs', () => {
  const prefs = {
    'agent.runner.kind': 'codex',
    'agent.runner.binPath': '/custom/codex',
    'agent.runner.extraArgs': ['--codex-profile', 42],
    'runner.automations': 'claude-code',
  };

  it('keeps custom launch settings only for their configured runner', () => {
    expect(resolveGatewayRunnerPrefs(prefs)).toEqual({
      kind: 'codex',
      binPath: '/custom/codex',
      extraArgs: ['--codex-profile'],
    });
  });

  it('uses registry launch defaults for a different manifest-requested runner', () => {
    expect(resolveGatewayRunnerPrefs(prefs, 'automations', 'claude-code')).toEqual({
      kind: 'claude-code',
    });
  });

  it('also isolates a subsystem pin from the default runner launch settings', () => {
    expect(resolveGatewayRunnerPrefs(prefs, 'automations')).toEqual({
      kind: 'claude-code',
    });
  });
});
