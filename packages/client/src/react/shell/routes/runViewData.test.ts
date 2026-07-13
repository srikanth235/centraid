import { describe, expect, it, vi } from 'vitest';
import { buildRunSnapshot } from './runViewData.js';

// `vi.mock` is hoisted above the import by vitest, so the gateway stub lands
// before runViewData.js pulls gateway-client-core's load-time side-effect.
vi.mock('../../../gateway-client.js', () => ({}));

const row = (): CentraidAutomationRow =>
  ({
    id: 'digest',
    ref: 'digest/main',
    name: 'Daily Digest',
    enabled: true,
    triggers: [{ kind: 'cron', expr: '0 9 * * *' }],
    manifest: { requires: { model: 'claude-opus-4-8' }, prompt: 'Summarize', history: {} },
  }) as unknown as CentraidAutomationRow;

const run = (over: Partial<CentraidAutomationRunRecord> = {}): CentraidAutomationRunRecord =>
  ({
    runId: 'r1',
    automationId: 'digest/main',
    kind: 'automation',
    triggerKind: 'scheduled',
    startedAt: Date.now() - 5000,
    ok: true,
    ...over,
  }) as unknown as CentraidAutomationRunRecord;

describe('buildRunSnapshot', () => {
  it('marks an in-flight run running with a pending final', () => {
    const snap = buildRunSnapshot(row(), run({ endedAt: undefined }), [], new Map());
    expect(snap.inFlight).toBe(true);
    expect(snap.statusKind).toBe('running');
    expect(snap.final.kind).toBe('pending');
  });

  it('marks a completed run success with an ok final', () => {
    const snap = buildRunSnapshot(
      row(),
      run({ endedAt: Date.now(), ok: true, summary: 'done' }),
      [],
      new Map(),
    );
    expect(snap.inFlight).toBe(false);
    expect(snap.statusKind).toBe('success');
    expect(snap.final.kind).toBe('ok');
  });

  it('renders a trigger log row plus one per node', () => {
    const nodes = [
      { runId: 'r1', ordinal: 1, kind: 'tool', name: 'fetch', startedAt: Date.now(), ok: true },
    ] as unknown as CentraidAutomationRunNode[];
    const snap = buildRunSnapshot(row(), run({ endedAt: Date.now() }), nodes, new Map());
    // trigger + node + completion row
    expect(snap.logRows.length).toBe(3);
    expect(snap.nodes).toHaveLength(1);
    expect(snap.nodes[0]?.name).toBe('fetch');
  });

  it('labels a data-originated run honestly instead of falling back to cron', () => {
    const snap = buildRunSnapshot(row(), run({ triggerOrigin: 'data' }), [], new Map());
    expect(snap.logKpi.triggerLabel).toBe('Data');
    expect(snap.logKpi.triggerIcon).toBe('Clock');
    expect(snap.logRows[0]?.label).toBe('Run started by data trigger');
  });

  it('labels a condition-originated run honestly instead of falling back to cron', () => {
    const snap = buildRunSnapshot(row(), run({ triggerOrigin: 'condition' }), [], new Map());
    expect(snap.logKpi.triggerLabel).toBe('Condition');
    expect(snap.logKpi.triggerIcon).toBe('Clock');
    expect(snap.logRows[0]?.label).toBe('Run started by condition trigger');
  });

  it('degrades gracefully to a raw-ref identity when the parent automation was deleted', () => {
    const snap = buildRunSnapshot(
      null,
      run({ endedAt: Date.now(), ok: true, automationId: 'digest/main' }),
      [],
      new Map(),
    );
    expect(snap.deleted).toBe(true);
    expect(snap.crumbName).toBe('digest/main');
    expect(snap.headerName).toBe('digest/main');
    expect(snap.promptInstr).toContain('deleted');
    expect(snap.triggersSummary).toBe('Trigger configuration unavailable');
  });

  it('falls back to the run id when a deleted run has no recorded automationId', () => {
    const snap = buildRunSnapshot(
      null,
      run({ endedAt: Date.now(), ok: true, automationId: undefined, runId: 'r9' }),
      [],
      new Map(),
    );
    expect(snap.crumbName).toBe('r9');
  });

  it('prefers the run-recorded automation name over the raw ref when the parent was deleted', () => {
    const snap = buildRunSnapshot(
      null,
      run({
        endedAt: Date.now(),
        ok: true,
        automationId: 'digest/main',
        automationName: 'Daily Digest',
      } as never),
      [],
      new Map(),
    );
    expect(snap.deleted).toBe(true);
    expect(snap.crumbName).toBe('Daily Digest');
    expect(snap.headerName).toBe('Daily Digest');
  });

  it('marks a live snapshot as not deleted when the row is present', () => {
    const snap = buildRunSnapshot(row(), run(), [], new Map());
    expect(snap.deleted).toBe(false);
  });

  it('surfaces streamed live text on an in-flight agent node', () => {
    const nodes = [
      { runId: 'r1', ordinal: 2, kind: 'agent', startedAt: Date.now(), ok: true },
    ] as unknown as CentraidAutomationRunNode[];
    const snap = buildRunSnapshot(
      row(),
      run({ endedAt: undefined }),
      nodes,
      new Map([[2, 'partial…']]),
    );
    expect(snap.nodes[0]?.liveText).toBe('partial…');
    expect(snap.nodes[0]?.streaming).toBe(true);
  });
});
