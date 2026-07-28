import { describe, expect, it, vi } from 'vitest';
import { buildAutomationAgentEditorData } from './automationEditorAgentData.js';
import { buildCreateAutomationEditorData } from './automationEditorCreateData.js';

// The route module transitively imports the whole gateway-client surface; we
// only exercise the pure create-mode DTO builder, so stub the client so
// importing the route needs no live gateway. (`vi.mock` is hoisted above the
// imports at transform time — the same seam automationEditorVault.test.ts uses.)
vi.mock('../../../gateway-client.js', () => ({}));
vi.mock('../../../assist-oauth-handoff.js', () => ({}));

describe('buildCreateAutomationEditorData', () => {
  it('opens trigger-less create mode with no template or watched entity', () => {
    const data = buildCreateAutomationEditorData({ instructions: 'do a thing', name: 'Untitled' });
    expect(data.mode).toBe('create');
    expect(data.automationId).toBeNull();
    expect(data.rowId).toBeNull();
    expect(data.instructions).toBe('do a thing');
    expect(data.name).toBe('Untitled');
    expect(data.triggers).toEqual([]);
  });

  it('seeds a data trigger watching the entity kind from watchEntity', () => {
    const data = buildCreateAutomationEditorData({
      watchEntity: 'core.transaction',
      instructions: '',
      name: 'Untitled',
    });
    expect(data.mode).toBe('create');
    expect(data.triggers).toEqual([{ entities: ['core.transaction'], kind: 'data' }]);
  });

  it("lets a template's own trigger kind win over watchEntity", () => {
    const cron = buildCreateAutomationEditorData({
      template: { name: 'Daily digest', desc: 'Every morning', triggerKind: 'cron' },
      watchEntity: 'core.transaction',
      instructions: 'x',
      name: 'x',
    });
    expect(cron.triggers).toEqual([{ expr: '0 9 * * *', kind: 'cron' }]);
    expect(cron.name).toBe('Daily digest');
    expect(cron.instructions).toBe('Every morning');

    const webhook = buildCreateAutomationEditorData({
      template: { name: 'On webhook', desc: 'When pinged', triggerKind: 'webhook' },
      watchEntity: 'core.transaction',
      instructions: 'x',
      name: 'x',
    });
    expect(webhook.triggers).toEqual([{ id: null, kind: 'webhook', pending: true }]);
  });

  it('falls back to watchEntity when a template carries no trigger kind', () => {
    const data = buildCreateAutomationEditorData({
      template: { name: 'Blank', desc: 'No trigger' },
      watchEntity: 'business.invoice',
      instructions: 'x',
      name: 'x',
    });
    expect(data.triggers).toEqual([{ entities: ['business.invoice'], kind: 'data' }]);
  });
});

describe('buildAutomationAgentEditorData', () => {
  it('derives effective automations pins and runner-scoped model defaults', () => {
    const data = buildAutomationAgentEditorData({
      anyLoading: false,
      cards: [
        {
          accent: '#111',
          connected: true,
          kind: 'codex',
          models: [{ default: true, id: 'gpt-catalog' }],
          modelsLoading: false,
          sessionReady: true,
          subtitle: 'ready',
          title: 'Codex',
        },
        {
          accent: '#222',
          connected: true,
          kind: 'acp',
          models: [{ default: true, id: 'acp-catalog' }],
          modelsLoading: false,
          sessionReady: true,
          subtitle: 'ready',
          title: 'Work ACP',
        },
      ],
      savedModelByKind: { acp: 'acp-saved' },
      defaultConfigPinsByKind: {},
      subsystemConfigPinsByKind: {},
      diagnosticsJson: '{}',
      selectedKind: 'codex',
      subsystemModelByKind: { acp: { automations: 'acp-automations' } },
      subsystemRunnerByKey: { automations: 'acp' },
      subsystemRunnerLadders: {},
    });

    expect(data.defaultRunnerKind).toBe('acp');
    expect(data.defaultModel).toBe('acp-automations');
    expect(data.agentRunners?.find((runner) => runner.kind === 'acp')).toMatchObject({
      defaultModel: 'acp-automations',
      label: 'Work ACP',
    });
  });
});
