import { describe, expect, it } from 'vitest';
import {
  formatWhereClauses,
  isValidCronExpr,
  isValidEntityName,
} from './BuilderAutomationTriggers.js';

// These mirror packages/automation/src/manifest/manifest.ts's own trigger
// validation rules (isValidCronExpression, the <schema>.<table> entity
// grammar, CONDITION_OPS) since the generic draft-file-write + publish path
// this pane persists through never runs that validator — see the file
// header comment in BuilderAutomationTriggers.tsx for why.

describe('isValidCronExpr', () => {
  it('accepts a standard 5-field expression', () => {
    expect(isValidCronExpr('0 9 * * *')).toBe(true);
    expect(isValidCronExpr('*/5 * * * *')).toBe(true);
    expect(isValidCronExpr('0 9 * * 1-5')).toBe(true);
  });

  it('rejects blank, wrong field count, and illegal characters', () => {
    expect(isValidCronExpr('')).toBe(false);
    expect(isValidCronExpr('   ')).toBe(false);
    expect(isValidCronExpr('0 9 * *')).toBe(false);
    expect(isValidCronExpr('0 9 * * * *')).toBe(false);
    expect(isValidCronExpr('0 9 * * $')).toBe(false);
  });

  it('tolerates extra surrounding/inner whitespace', () => {
    expect(isValidCronExpr('  0   9  *  *  * ')).toBe(true);
  });
});

describe('isValidEntityName', () => {
  it('accepts <schema>.<table> names', () => {
    expect(isValidEntityName('core.transaction')).toBe(true);
    expect(isValidEntityName('business.invoice')).toBe(true);
    expect(isValidEntityName('a1.b_2')).toBe(true);
  });

  it('rejects names missing the schema.table shape', () => {
    expect(isValidEntityName('invoice')).toBe(false);
    expect(isValidEntityName('Core.Transaction')).toBe(false);
    expect(isValidEntityName('core.')).toBe(false);
    expect(isValidEntityName('.transaction')).toBe(false);
    expect(isValidEntityName('core.trans.action')).toBe(false);
  });
});

describe('formatWhereClauses', () => {
  it('returns null for an empty/absent where', () => {
    expect(formatWhereClauses(undefined)).toBeNull();
    expect(formatWhereClauses([])).toBeNull();
  });

  it('pretty-prints one clause per line, quoting non-numeric values', () => {
    const out = formatWhereClauses([
      { column: 'status', op: 'eq', value: 'open' },
      { column: 'days_left', op: 'within-days', value: 3 },
      { column: 'archived_at', op: 'is-null' },
    ]);
    expect(out).toBe('status eq "open"\ndays_left within-days 3\narchived_at is-null');
  });

  it('falls back to raw JSON for a shape it cannot structurally print', () => {
    const weird = [{ nope: true }];
    expect(formatWhereClauses(weird)).toBe(JSON.stringify(weird, null, 2));
  });
});
