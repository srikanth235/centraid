import { describe, expect, it, vi } from 'vitest';
import { buildCreateAutomationEditorData } from './AutomationEditorRoute.js';

// The route module transitively imports the whole gateway-client surface; we
// only exercise the pure create-mode DTO builder, so stub the client so
// importing the route needs no live gateway. (`vi.mock` is hoisted above the
// imports at transform time — the same seam automationEditorVault.test.ts uses.)
vi.mock('../../../gateway-client.js', () => ({}));

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
