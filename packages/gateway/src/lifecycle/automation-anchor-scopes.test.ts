import {
  createGateway,
  createGrant,
  ensureAppEnrolled,
  ensureVaultBootstrapped,
  openVaultDb,
  purposeConceptId,
} from '@centraid/vault';
import { afterEach, expect, test } from 'vitest';
import {
  AutomationAnchorError,
  resolveAutomationAnchors,
  scopesForAutomationAnchors,
} from './automation-anchor-scopes.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function anchoredTaskFixture() {
  const db = openVaultDb();
  cleanups.push(() => db.close());
  const boot = ensureVaultBootstrapped(db, { ownerName: 'Priya' });
  const insertTask = db.vault.prepare(
    `INSERT INTO schedule_task
       (task_id, owner_party_id, title, description, status, priority)
     VALUES (?, ?, ?, ?, 'needs-action', 5)`,
  );
  insertTask.run(
    'task-anchored',
    boot.ownerPartyId,
    'Prepare quarterly report today',
    'Sensitive detail',
  );
  insertTask.run(
    'task-other',
    boot.ownerPartyId,
    'Prepare another report today',
    'Must remain hidden',
  );
  const relation = db.vault.prepare('SELECT concept_id FROM core_concept LIMIT 1').get() as {
    concept_id: string;
  };
  db.vault
    .prepare(
      `INSERT INTO core_link
       (link_id, from_type, from_id, to_type, to_id, relation_concept_id,
        valid_from, valid_to, asserted_by, provenance_id)
       VALUES ('link-1', 'schedule.task', 'task-anchored', 'core.party', ?,
               ?, '2026-07-25T00:00:00.000Z', NULL, 'owner', NULL)`,
    )
    .run(boot.ownerPartyId, relation.concept_id);
  db.vault
    .prepare(
      `INSERT INTO core_link_anchor (anchor_id, link_id, selector_json, created_at)
       VALUES ('anchor-1', 'link-1', ?, '2026-07-25T00:00:00.000Z')`,
    )
    .run(
      JSON.stringify({
        exact: 'quarterly report',
        prefix: 'Prepare ',
        suffix: ' today',
        start: 8,
      }),
    );
  return { boot, db };
}

test('anchor token resolves to its trusted row, field, and span', () => {
  const { db } = anchoredTaskFixture();
  expect(resolveAutomationAnchors(db, 'Notify about @[core.link_anchor/anchor-1].')).toEqual([
    expect.objectContaining({
      anchorId: 'anchor-1',
      linkId: 'link-1',
      sourceType: 'schedule.task',
      sourceId: 'task-anchored',
      sourceField: 'title',
      targetType: 'core.party',
      selector: expect.objectContaining({ exact: 'quarterly report', start: 8 }),
      scope: {
        schema: 'schedule',
        table: 'task',
        verbs: 'read',
        rowFilter: [{ column: 'task_id', op: 'eq', value: 'task-anchored' }],
        fieldMask: ['task_id', 'title'],
      },
    }),
  ]);
});

test('derived anchor scope is enforced as one row and two fields', () => {
  const { boot, db } = anchoredTaskFixture();
  const [anchor] = resolveAutomationAnchors(db, '@[core.link_anchor/anchor-1]');
  const app = ensureAppEnrolled(db, 'anchored-automation');
  createGrant(db, {
    appId: app.appId,
    purposeConceptId: purposeConceptId(db, 'dpv:ServiceProvision') as string,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [anchor!.scope],
  });
  const result = createGateway(db).read(
    { kind: 'app', appId: app.appId, signingKey: app.signingKey },
    { entity: 'schedule.task', purpose: 'dpv:ServiceProvision' },
  );
  expect(result.rows).toEqual([
    { task_id: 'task-anchored', title: 'Prepare quarterly report today' },
  ]);
});

test('ended or stale anchors fail closed', () => {
  const { db } = anchoredTaskFixture();
  db.vault
    .prepare(`UPDATE core_link SET valid_to = '2026-07-25T01:00:00.000Z' WHERE link_id = 'link-1'`)
    .run();
  expect(() => resolveAutomationAnchors(db, '@[core.link_anchor/anchor-1]')).toThrow(
    AutomationAnchorError,
  );
});

test('same-table anchors compile to one bounded row union', () => {
  const { boot, db } = anchoredTaskFixture();
  const [first] = resolveAutomationAnchors(db, '@[core.link_anchor/anchor-1]');
  const second = {
    ...first!,
    anchorId: 'anchor-2',
    sourceId: 'task-other',
    sourceField: 'description',
    scope: {
      ...first!.scope,
      rowFilter: [{ column: 'task_id', op: 'eq' as const, value: 'task-other' }],
      fieldMask: ['task_id', 'description'],
    },
  };
  const combined = scopesForAutomationAnchors([first!, second]);
  expect(combined).toEqual([
    {
      schema: 'schedule',
      table: 'task',
      verbs: 'read',
      rowFilter: [
        {
          column: 'task_id',
          op: 'in',
          value: ['task-anchored', 'task-other'],
        },
      ],
      fieldMask: ['task_id', 'title', 'description'],
    },
  ]);
  const app = ensureAppEnrolled(db, 'multi-anchor-automation');
  const grant = (scopes: Parameters<typeof createGrant>[1]['scopes']): void => {
    createGrant(db, {
      appId: app.appId,
      purposeConceptId: purposeConceptId(db, 'dpv:ServiceProvision') as string,
      grantedByPartyId: boot.ownerPartyId,
      scopes,
    });
  };
  grant([first!.scope]);
  grant(combined);
  const rows = createGateway(db).read(
    { kind: 'app', appId: app.appId, signingKey: app.signingKey },
    { entity: 'schedule.task', purpose: 'dpv:ServiceProvision' },
  ).rows;
  expect(rows).toHaveLength(2);
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ task_id: 'task-anchored' }),
      expect.objectContaining({ task_id: 'task-other' }),
    ]),
  );
});
