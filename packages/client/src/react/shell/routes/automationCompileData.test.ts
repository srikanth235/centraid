import { describe, expect, it, vi } from 'vitest';
import { compileAttemptOf, compileStepOf, compileSteps } from './automationCompileData.js';

// `automationCompileData.ts` imports the gateway-client barrel; stub it so
// pulling the module in doesn't run gateway-client-core's load-time
// `window.CentraidApi` side effect (same guard automationsData.test.ts uses).
vi.mock('../../../gateway-client.js', () => ({
  listAutomationTurns: vi.fn(),
  readAutomationTurnExpanded: vi.fn(),
  streamAutomationTurn: vi.fn(),
}));

const item = (over: Partial<CentraidAutomationItem> = {}): CentraidAutomationItem =>
  ({
    itemId: 'i1',
    turnId: 'c-1',
    ordinal: 0,
    kind: 'tool',
    name: 'write_file',
    ok: true,
    startedAt: 1000,
    endedAt: 1200,
    durationMs: 200,
    ...over,
  }) as CentraidAutomationItem;

describe('compileStepOf', () => {
  it('drops the compiler input item — the instructions are already on screen', () => {
    expect(compileStepOf(item({ kind: 'message_in', name: undefined }))).toBeNull();
  });

  it('surfaces the error as the detail on a failed step', () => {
    const step = compileStepOf(
      item({ ok: false, error: 'unexpected token', outputJson: '{"path":"handler.js"}' }),
    );
    expect(step).toMatchObject({ status: 'fail', label: 'write_file', detail: 'unexpected token' });
  });

  it('marks an unfinished step running rather than failed', () => {
    const step = compileStepOf(item({ endedAt: undefined, durationMs: undefined }));
    expect(step?.status).toBe('running');
    expect(step?.durationMs).toBeNull();
  });

  it('prefers a readable field over the raw JSON envelope', () => {
    expect(compileStepOf(item({ outputJson: '{"path":"handler.js","bytes":9182}' }))?.detail).toBe(
      'handler.js',
    );
    // No readable field and no text ⇒ no detail, rather than a JSON blob.
    expect(compileStepOf(item({ outputJson: '{"bytes":9182}' }))?.detail).toBeNull();
  });

  it('names a model step by its model instead of leaving it blank', () => {
    expect(compileStepOf(item({ kind: 'step', name: undefined, model: 'sonnet' }))?.label).toBe(
      'Model · sonnet',
    );
  });
});

describe('compileSteps', () => {
  it('orders by ordinal so a live stream reads in the order work happened', () => {
    const steps = compileSteps([
      item({ itemId: 'b', ordinal: 2, name: 'typecheck' }),
      item({ itemId: 'a', ordinal: 1, name: 'write_file' }),
      item({ itemId: 'in', ordinal: 0, kind: 'message_in', name: undefined }),
    ]);
    expect(steps.map((s) => s.label)).toEqual(['write_file', 'typecheck']);
  });
});

describe('compileAttemptOf', () => {
  it('reads an unfinished compile as running, not as a failure', () => {
    const attempt = compileAttemptOf({
      turnId: 'c-1',
      startedAt: Date.now(),
      ok: false,
      pinned: false,
    } as unknown as CentraidAutomationTurnRecord);
    expect(attempt.status).toBe('running');
    expect(attempt.endedAt).toBeNull();
  });

  it('carries the failure text the fix-it assistant is seeded with', () => {
    const attempt = compileAttemptOf({
      turnId: 'c-1',
      startedAt: Date.now(),
      endedAt: Date.now(),
      ok: false,
      error: 'handler.js: unexpected token',
      pinned: false,
    } as unknown as CentraidAutomationTurnRecord);
    expect(attempt).toMatchObject({ status: 'fail', error: 'handler.js: unexpected token' });
  });
});
