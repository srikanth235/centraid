import { describe, expect, it } from 'vitest';
import { resolveAutomationAgentSelection } from './automation-agent-selection.js';

describe('resolveAutomationAgentSelection', () => {
  const prefs = {
    'model.codex.automations': 'codex-auto',
    'model.claude-code.automations': 'claude-auto',
    'model.claude-code.default': 'claude-default',
  };

  it('gives valid manifest runner/model pins priority over subsystem prefs', () => {
    expect(
      resolveAutomationAgentSelection(
        { runner: 'claude-code', model: 'claude-explicit' },
        prefs,
        'codex',
      ),
    ).toEqual({ runner: 'claude-code', model: 'claude-explicit' });
  });

  it('falls back from an unregistered open key and scopes model prefs to that fallback', () => {
    expect(resolveAutomationAgentSelection({ runner: 'future-runner' }, prefs, 'codex')).toEqual({
      runner: 'codex',
      model: 'codex-auto',
    });
  });

  it('uses the pinned runner subsystem model when no model is explicit', () => {
    expect(resolveAutomationAgentSelection({ runner: 'claude-code' }, prefs, 'codex')).toEqual({
      runner: 'claude-code',
      model: 'claude-auto',
    });
  });
});
