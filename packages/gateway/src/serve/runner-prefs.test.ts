import { describe, expect, it } from 'vitest';
import { removedRunnerLadderMembers, resolveGatewayRunnerPrefs } from './runner-prefs.js';

describe('resolveGatewayRunnerPrefs', () => {
  const prefs = {
    'agent.runner.kind': 'codex',
    'agent.runner.binPath': '/custom/codex',
    'agent.runner.extraArgs': ['--codex-profile', 42],
    'runner.automations': 'claude-code',
    'config.codex.default.thought_level': 'medium',
    'config.claude-code.default.thought_level': 'low',
    'config.claude-code.automations.thought_level': 'high',
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
      configPins: { thought_level: 'high' },
    });
  });

  it('also isolates a subsystem pin from the default runner launch settings', () => {
    expect(resolveGatewayRunnerPrefs(prefs, 'automations')).toEqual({
      kind: 'claude-code',
      configPins: { thought_level: 'high' },
    });
  });
});

describe('removedRunnerLadderMembers', () => {
  it('reports removal from one subsystem even when another ladder retains the runner', () => {
    const before = {
      'agent.runner.kind': 'codex',
      'runner.ladder.assistant': ['claude-code'],
      'runner.ladder.automations': ['claude-code'],
    };
    const after = {
      ...before,
      'runner.ladder.assistant': [],
    };

    expect(removedRunnerLadderMembers(before, after)).toEqual([
      { subsystem: 'assistant', kind: 'claude-code' },
    ]);
  });

  it('resolves default-ladder membership independently for every subsystem', () => {
    const before = {
      'agent.runner.kind': 'codex',
      'runner.ladder.default': ['claude-code'],
      'runner.ladder.assistant': ['claude-code'],
    };
    const after = {
      ...before,
      'runner.ladder.default': [],
    };

    expect(removedRunnerLadderMembers(before, after)).toEqual([
      { subsystem: 'ask', kind: 'claude-code' },
      { subsystem: 'builder', kind: 'claude-code' },
      { subsystem: 'automations', kind: 'claude-code' },
    ]);
  });
});
