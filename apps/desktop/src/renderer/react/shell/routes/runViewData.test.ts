import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../gateway-client.js', () => ({}));

import { buildRunSnapshot } from './runViewData.js';

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
