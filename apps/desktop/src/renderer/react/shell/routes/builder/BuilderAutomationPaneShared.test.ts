import { describe, expect, it } from 'vitest';
import {
  fmtRetention,
  getVaultBlock,
  manifestHasVault,
  relTime,
  runOriginLabel,
} from './BuilderAutomationPaneShared.js';

function run(patch: Partial<CentraidAutomationRunRecord>): CentraidAutomationRunRecord {
  return {
    runId: 'r1',
    kind: 'automation',
    triggerKind: 'scheduled',
    startedAt: Date.now(),
    ok: true,
    pinned: false,
    ...patch,
  };
}

// GAP 3: the Runs tab used to print the raw `triggerKind` ('scheduled' /
// 'manual' / …), which can't tell a cron fire from a data/condition one.
// This must match automationsData.ts:229-238's mapping exactly (that file is
// owned by another concurrent change and is not editable from here).
describe('runOriginLabel', () => {
  it('prefers triggerOrigin, Title-Cased', () => {
    expect(runOriginLabel(run({ triggerOrigin: 'webhook' }))).toBe('Webhook');
    expect(runOriginLabel(run({ triggerOrigin: 'data' }))).toBe('Data');
    expect(runOriginLabel(run({ triggerOrigin: 'condition' }))).toBe('Condition');
  });

  it('falls back to triggerKind when triggerOrigin is absent', () => {
    expect(runOriginLabel(run({ triggerKind: 'manual' }))).toBe('Manual');
    expect(runOriginLabel(run({ triggerKind: 'scheduled' }))).toBe('Cron');
    expect(runOriginLabel(run({ triggerKind: 'replay' }))).toBe('Cron');
  });

  it('a cron-origin run still reads as Cron (matches automationsData.ts)', () => {
    expect(runOriginLabel(run({ triggerOrigin: 'cron', triggerKind: 'scheduled' }))).toBe('Cron');
  });
});

describe('fmtRetention', () => {
  it('formats every HistoryKeep shape', () => {
    expect(fmtRetention('all')).toBe('Keep all runs');
    expect(fmtRetention('errors')).toBe('Keep failed runs only');
    expect(fmtRetention({ count: 50 })).toBe('Last 50 runs');
    expect(fmtRetention({ days: 7 })).toBe('Last 7 days');
  });
});

describe('relTime', () => {
  it('buckets by age', () => {
    const now = Date.now();
    expect(relTime(now)).toBe('just now');
    expect(relTime(now - 5 * 60_000)).toBe('5m ago');
    expect(relTime(now - 3 * 3_600_000)).toBe('3h ago');
    expect(relTime(now - 2 * 86_400_000)).toBe('2d ago');
  });
});

describe('manifestHasVault', () => {
  const base: CentraidAutomationManifest = {
    name: 'test',
    version: '0.1.0',
    enabled: true,
    prompt: 'do a thing',
    triggers: [],
    requires: {},
    history: { keep: { count: 100 } },
    generated: { by: 'agent', at: new Date().toISOString() },
  };

  it('is false when the manifest carries no vault block', () => {
    expect(manifestHasVault(base)).toBe(false);
  });

  it('is true when the manifest carries a vault block (untyped in the ambient global)', () => {
    const withVault = { ...base, vault: { purpose: 'dpv:ServiceProvision', scopes: [] } };
    expect(manifestHasVault(withVault as CentraidAutomationManifest)).toBe(true);
  });
});

describe('getVaultBlock', () => {
  const base: CentraidAutomationManifest = {
    name: 'test',
    version: '0.1.0',
    enabled: true,
    prompt: 'do a thing',
    triggers: [],
    requires: {},
    history: { keep: { count: 100 } },
    generated: { by: 'agent', at: new Date().toISOString() },
  };

  it('is undefined when the manifest carries no vault block', () => {
    expect(getVaultBlock(base)).toBeUndefined();
  });

  it('reads the typed vault block through when present', () => {
    const withVault = {
      ...base,
      vault: {
        purpose: 'dpv:ServiceProvision',
        why: 'Reads invoice status.',
        scopes: [{ schema: 'business', table: 'invoice', verbs: 'read' }],
      },
    };
    const block = getVaultBlock(withVault as CentraidAutomationManifest);
    expect(block?.purpose).toBe('dpv:ServiceProvision');
    expect(block?.why).toBe('Reads invoice status.');
    expect(block?.scopes).toEqual([{ schema: 'business', table: 'invoice', verbs: 'read' }]);
  });
});
