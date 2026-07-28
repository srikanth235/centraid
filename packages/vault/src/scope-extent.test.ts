// One covering rule, two stores. SQLite rows say `null` for an unset column
// and manifests say `undefined`; both planes must read them identically, or
// the install-grant top-up and the consent memory come to disagree about what
// the owner said (issue #541 review).

import { describe, expect, test } from 'vitest';

import { scopeCovers } from './scope-extent.js';

describe('scope-extent', () => {
  test('an unset table is schema-wide whether it arrives as null or undefined', () => {
    const inner = { schema: 'core', table: 'core_task', verbs: 'read' };
    expect(scopeCovers({ schema: 'core', table: null, verbs: 'read' }, inner)).toBe(true);
    expect(scopeCovers({ schema: 'core', table: undefined, verbs: 'read' }, inner)).toBe(true);
    expect(scopeCovers({ schema: 'core', verbs: 'read' }, inner)).toBe(true);
    // …and the inner side reads the same both ways.
    expect(
      scopeCovers({ schema: 'core', table: 'core_task', verbs: 'read' }, { ...inner, table: null }),
    ).toBe(false);
  });

  test('covering is one-directional: broad covers narrow, never the reverse', () => {
    const broad = { schema: 'core', verbs: 'read' };
    const narrow = { schema: 'core', table: 'core_task', verbs: 'read' };
    expect(scopeCovers(broad, narrow)).toBe(true);
    expect(scopeCovers(narrow, broad)).toBe(false);
    expect(scopeCovers(narrow, narrow)).toBe(true);
  });

  test('schema and verbs must match exactly — verb grading is not an extent property', () => {
    expect(
      scopeCovers({ schema: 'core', verbs: 'read+act' }, { schema: 'core', verbs: 'read' }),
    ).toBe(false);
    expect(
      scopeCovers({ schema: 'core', verbs: 'read' }, { schema: 'knowledge', verbs: 'read' }),
    ).toBe(false);
  });

  test('an unset row filter covers a filtered extent; two set filters must be identical', () => {
    const filter = [{ column: 'task_id', op: 'eq' as const, value: 'a' }];
    const unfiltered = { schema: 'core', table: 'core_task', verbs: 'read' };
    const filtered = { ...unfiltered, rowFilter: filter };
    expect(scopeCovers(unfiltered, filtered)).toBe(true);
    expect(scopeCovers({ ...unfiltered, rowFilter: null }, filtered)).toBe(true);
    expect(scopeCovers(filtered, unfiltered)).toBe(false);
    expect(
      scopeCovers(filtered, {
        ...unfiltered,
        rowFilter: structuredClone(filter),
      }),
    ).toBe(true);
    expect(
      scopeCovers(filtered, {
        ...unfiltered,
        rowFilter: [{ column: 'task_id', op: 'eq', value: 'b' }],
      }),
    ).toBe(false);
  });

  test('an unset field mask is all fields; a set mask covers only its subsets', () => {
    const table = { schema: 'core', table: 'core_task', verbs: 'read' };
    expect(scopeCovers(table, { ...table, fieldMask: ['title'] })).toBe(true);
    expect(scopeCovers({ ...table, fieldMask: null }, { ...table, fieldMask: ['title'] })).toBe(
      true,
    );
    expect(
      scopeCovers({ ...table, fieldMask: ['title', 'body'] }, { ...table, fieldMask: ['title'] }),
    ).toBe(true);
    expect(
      scopeCovers({ ...table, fieldMask: ['title'] }, { ...table, fieldMask: ['title', 'body'] }),
    ).toBe(false);
    // All fields is not a subset of any mask.
    expect(scopeCovers({ ...table, fieldMask: ['title'] }, table)).toBe(false);
    expect(scopeCovers({ ...table, fieldMask: ['title'] }, { ...table, fieldMask: null })).toBe(
      false,
    );
  });
});
