import { createTestVault } from '@centraid/test-kit/factories';
import { recordQualityResult } from '@centraid/test-kit/quality-result';
import { browseRows } from '../../packages/vault/src/schema/atlas-browse.js';
import { expect, test } from 'vitest';

const OWNER = 'tests/scale/ontology.scale.test.ts';

test('Atlas/Browse paginates 10k party kinds and their authored relations', async () => {
  const db = await createTestVault();
  const insertParty = db.vault.prepare(
    `INSERT INTO core_party
      (party_id, kind, display_name, created_at, updated_at, ontology_version)
     VALUES (?, 'person', ?, ?, ?, '1.2')`,
  );
  db.vault
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, version)
       VALUES ('scale-relations', 'urn:centraid:scale', 'Scale relations', '1')`,
    )
    .run();
  db.vault
    .prepare(
      `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label)
       VALUES ('scale-knows', 'scale-relations', 'knows', 'Knows')`,
    )
    .run();
  const insertLink = db.vault.prepare(
    `INSERT INTO core_link
      (link_id, from_type, from_id, to_type, to_id, relation_concept_id, valid_from, asserted_by)
     VALUES (?, 'core.party', ?, 'core.party', ?, 'scale-knows', ?, 'owner')`,
  );
  db.vault.exec('BEGIN IMMEDIATE');
  for (let index = 0; index < 10_000; index += 1) {
    const id = `scale-${String(index).padStart(5, '0')}`;
    insertParty.run(id, `Synthetic ${index}`, index, index);
    if (index > 0) {
      const previous = `scale-${String(index - 1).padStart(5, '0')}`;
      insertLink.run(`scale-link-${String(index).padStart(5, '0')}`, previous, id, String(index));
    }
  }
  db.vault.exec('COMMIT');

  function pageCount(table: string, orderBy: string): number {
    let cursor: string | undefined;
    let count = 0;
    do {
      const page = browseRows(db.vault, {
        table,
        orderBy,
        limit: 500,
        ...(cursor ? { after: cursor } : {}),
      });
      count += page.rows.length;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return count;
  }

  const started = performance.now();
  const partyCount = pageCount('core.party', 'party_id');
  const relationCount = pageCount('core.link', 'link_id');
  const durationMs = performance.now() - started;
  const passed = partyCount === 10_001 && relationCount === 9_999 && durationMs < 10_000;
  await recordQualityResult({
    lane: 'scale',
    owner: OWNER,
    name: 'Atlas/Browse kinds and relations at 10k entities',
    status: passed ? 'passed' : 'failed',
    measurements: [
      { name: 'wall clock', value: durationMs, unit: 'ms', budget: 10_000 },
      { name: 'party rows paged', value: partyCount, unit: 'rows' },
      { name: 'relation rows paged', value: relationCount, unit: 'rows' },
    ],
  });
  expect(partyCount).toBe(10_001);
  expect(relationCount).toBe(9_999);
  expect(durationMs).toBeLessThan(10_000);
});
