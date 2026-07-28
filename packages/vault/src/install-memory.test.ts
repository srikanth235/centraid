// Consent memory (issue #308 A4): what an owner approval does — and does NOT
// do — to a standing revocation. The direction of `scopeCovers` is the whole
// invariant: a "no" only dies to a "yes" that covers it.

import { beforeEach, describe, expect, test } from 'vitest';

import { bootstrapVault, enrollApp } from './bootstrap.js';
import { openVaultDb, type VaultDb } from './db.js';
import {
  clearScopeTombstones,
  listScopeTombstones,
  writeScopeTombstones,
  type GranteeKey,
  type ScopeTriple,
} from './install-memory.js';

let db: VaultDb;
let grantee: GranteeKey;

describe('install-memory', () => {
  beforeEach(() => {
    db = openVaultDb();
    bootstrapVault(db, { ownerName: 'Priya' });
    grantee = { appId: enrollApp(db, { name: 'planner' }).appId };
  });

  const tombstones = (): ScopeTriple[] => listScopeTombstones(db, grantee);

  test('a narrow approval leaves the broader revocation standing (issue #541)', () => {
    // The owner refuses the whole `core` schema for reads.
    writeScopeTombstones(db, grantee, [{ schema: 'core', verbs: 'read' }]);

    // Later they approve ONE anchored table read. That is a yes to core_task —
    // not a retraction of the schema-wide no.
    clearScopeTombstones(db, grantee, [{ schema: 'core', table: 'core_task', verbs: 'read' }]);

    expect(tombstones()).toStrictEqual([{ schema: 'core', verbs: 'read' }]);
  });

  test('a narrow approval does not erase a whole-row or unmasked revocation', () => {
    writeScopeTombstones(db, grantee, [
      { schema: 'core', table: 'core_task', verbs: 'read' },
      {
        schema: 'core',
        table: 'core_note',
        verbs: 'read',
        fieldMask: ['title', 'body'],
      },
    ]);

    clearScopeTombstones(db, grantee, [
      // A field-masked yes never covers a whole-row no…
      {
        schema: 'core',
        table: 'core_task',
        verbs: 'read',
        fieldMask: ['title'],
      },
      // …and a mask only covers a mask it is a superset of.
      {
        schema: 'core',
        table: 'core_note',
        verbs: 'read',
        fieldMask: ['title'],
      },
      // A row-filtered yes never covers an unfiltered no.
      {
        schema: 'core',
        table: 'core_task',
        verbs: 'read',
        rowFilter: [{ column: 'task_id', op: 'eq', value: 'a' }],
      },
    ]);

    expect(tombstones()).toHaveLength(2);
  });

  test('an approval clears exactly the tombstones it covers', () => {
    writeScopeTombstones(db, grantee, [
      { schema: 'core', table: 'core_task', verbs: 'read' },
      {
        schema: 'core',
        table: 'core_note',
        verbs: 'read',
        rowFilter: [{ column: 'note_id', op: 'eq', value: 'n1' }],
        fieldMask: ['title'],
      },
      // Same schema, different verb — verbs match exactly, never by grading.
      { schema: 'core', table: 'core_task', verbs: 'act' },
      { schema: 'knowledge', verbs: 'read' },
    ]);
    expect(tombstones()).toHaveLength(4);

    // Schema-wide, unfiltered, unmasked read: covers both `core` read "no"s.
    clearScopeTombstones(db, grantee, [{ schema: 'core', verbs: 'read' }]);

    expect(tombstones()).toStrictEqual([
      { schema: 'core', table: 'core_task', verbs: 'act' },
      { schema: 'knowledge', verbs: 'read' },
    ]);
  });

  test('re-approving the exact revoked extent clears it (the ordinary heal path)', () => {
    const extent: ScopeTriple = {
      schema: 'schedule',
      table: 'schedule_event',
      verbs: 'read+act',
      rowFilter: [{ column: 'calendar_id', op: 'in', value: ['work'] }],
      fieldMask: ['event_id', 'title'],
    };
    writeScopeTombstones(db, grantee, [extent]);
    clearScopeTombstones(db, grantee, [structuredClone(extent)]);
    expect(tombstones()).toStrictEqual([]);
  });

  test('tombstones are per grantee: one app approval does not clear another party', () => {
    const other: GranteeKey = { appId: enrollApp(db, { name: 'notes' }).appId };
    writeScopeTombstones(db, grantee, [{ schema: 'core', verbs: 'read' }]);
    writeScopeTombstones(db, other, [{ schema: 'core', verbs: 'read' }]);

    clearScopeTombstones(db, grantee, [{ schema: 'core', verbs: 'read' }]);

    expect(tombstones()).toStrictEqual([]);
    expect(listScopeTombstones(db, other)).toHaveLength(1);
  });

  test('a revocation is written once per extent, and extents differ by filter/mask', () => {
    const base: ScopeTriple = {
      schema: 'core',
      table: 'core_task',
      verbs: 'read',
    };
    expect(writeScopeTombstones(db, grantee, [base, structuredClone(base)])).toBe(1);
    expect(writeScopeTombstones(db, grantee, [base])).toBe(0);
    expect(writeScopeTombstones(db, grantee, [{ ...base, fieldMask: ['title'] }])).toBe(1);
    expect(tombstones()).toHaveLength(2);
  });
});
