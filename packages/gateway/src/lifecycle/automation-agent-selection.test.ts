import { describe, expect, it } from 'vitest';

import {
  resolveAutomationAgentSelection,
  resolveAutomationRewriteModel,
} from './automation-agent-selection.js';

describe(resolveAutomationAgentSelection, () => {
  const prefs = {
    'model.codex.automations': 'codex-auto',
    'model.claude-code.automations': 'claude-auto',
    'model.claude-code.default': 'claude-default',
    'config.claude-code.default.thought_level': 'medium',
    'config.claude-code.automations.thought_level': 'high',
  };

  it('gives valid manifest runner/model pins priority over subsystem prefs', () => {
    expect(
      resolveAutomationAgentSelection(
        { runner: 'claude-code', model: 'claude-explicit' },
        prefs,
        'codex',
      ),
    ).toStrictEqual({
      runner: 'claude-code',
      // The manifest named a provider the user's automations lane does not
      // use, so this selection is not consent for unattended egress (#567).
      selectionSource: 'manifest',
      model: 'claude-explicit',
      configPins: { thought_level: 'high' },
    });
  });

  it('falls back from an unregistered open key and scopes model prefs to that fallback', () => {
    expect(
      resolveAutomationAgentSelection({ runner: 'future-runner' }, prefs, 'codex'),
    ).toStrictEqual({
      runner: 'codex',
      // Falling back lands on the user's own automations runner.
      selectionSource: 'prefs',
      model: 'codex-auto',
    });
  });

  it('uses the pinned runner subsystem model when no model is explicit', () => {
    expect(
      resolveAutomationAgentSelection({ runner: 'claude-code' }, prefs, 'codex'),
    ).toStrictEqual({
      runner: 'claude-code',
      selectionSource: 'manifest',
      model: 'claude-auto',
      configPins: { thought_level: 'high' },
    });
  });

  it('reports a manifest pin that names the user own runner as prefs-authored', () => {
    expect(
      resolveAutomationAgentSelection({ runner: 'claude-code' }, prefs, 'claude-code'),
    ).toMatchObject({ runner: 'claude-code', selectionSource: 'prefs' });
  });

  it('gives a manifest thought-level pin priority over prefs', () => {
    expect(
      resolveAutomationAgentSelection(
        { runner: 'claude-code', thoughtLevel: 'max' },
        prefs,
        'codex',
      ),
    ).toMatchObject({ configPins: { thought_level: 'max' } });
  });

  it('keeps an explicit automation model ahead of rewrite and catalog defaults', () => {
    expect(
      resolveAutomationRewriteModel(
        { runner: 'claude-code', model: 'claude-explicit' },
        { runner: 'claude-code', model: 'claude-explicit' },
        'claude-rewrite',
        'claude-fast',
      ),
    ).toBe('claude-explicit');
  });

  it('uses the rewrite tier only when the automation has no explicit model', () => {
    expect(
      resolveAutomationRewriteModel(
        { runner: 'claude-code' },
        { runner: 'claude-code', model: 'claude-automation-default' },
        'claude-rewrite',
        'claude-fast',
      ),
    ).toBe('claude-rewrite');
  });
});
