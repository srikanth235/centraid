// The batched derivative resolve (issue #405 §2): "tinies for these N content
// ids in one pass". Rows are inserted directly (no command pipeline) — this is
// a pure query test, so it pins the contract in isolation: variant filtering,
// absent ids, and the >500-id chunk boundary the IN list splits on.

import { beforeEach, expect, test } from 'vitest';
import { openVaultDb, type VaultDb } from '../db.js';
import { nowIso, uuidv7 } from '../ids.js';
import { resolveDerivativeShas } from './read.js';

let db: VaultDb;

beforeEach(() => {
  db = openVaultDb();
});

/** Insert a bare content item and (optionally) one binary rung for it. */
function seed(contentId: string, sha: string, variant?: 'thumb' | 'preview'): void {
  db.vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES (?, 'image/jpeg', ?, ?, 10, ?)`,
    )
    .run(contentId, `blob:sha256:${sha}`, sha, nowIso());
  if (variant) {
    db.vault
      .prepare(
        `INSERT INTO core_content_derivative
           (derivative_id, content_id, variant, sha256, media_type, byte_size, created_at)
         VALUES (?, ?, ?, ?, 'image/jpeg', 20, ?)`,
      )
      .run(uuidv7(), contentId, variant, `d${sha}`.slice(0, 64).padEnd(64, '0'), nowIso());
  }
}

function sha(n: number): string {
  return String(n).padStart(64, '0');
}

test('resolves the requested rung for many ids, one map, absent ids omitted', () => {
  const withThumb = ['a', 'b', 'c'];
  withThumb.forEach((id, i) => seed(id, sha(i), 'thumb'));
  seed('no-rung', sha(99)); // exists but has no derivative

  const map = resolveDerivativeShas(db.vault, [...withThumb, 'no-rung', 'never-seen'], 'thumb');
  expect(map.size).toBe(3);
  expect(map.has('no-rung')).toBe(false); // no rung → absent, caller placeholders
  expect(map.has('never-seen')).toBe(false); // unknown id → absent
  expect(map.get('a')?.mediaType).toBe('image/jpeg');
  expect(map.get('a')?.byteSize).toBe(20);
});

test('variant filter: a preview request never returns thumb rows', () => {
  seed('only-thumb', sha(1), 'thumb');
  seed('only-preview', sha(2), 'preview');
  const thumbs = resolveDerivativeShas(db.vault, ['only-thumb', 'only-preview'], 'thumb');
  expect([...thumbs.keys()]).toEqual(['only-thumb']);
  const previews = resolveDerivativeShas(db.vault, ['only-thumb', 'only-preview'], 'preview');
  expect([...previews.keys()]).toEqual(['only-preview']);
});

test('crosses the 500-id chunk boundary in one call', () => {
  const ids: string[] = [];
  for (let i = 0; i < 550; i += 1) {
    const id = `c${i}`;
    ids.push(id);
    seed(id, sha(1000 + i), 'thumb');
  }
  const map = resolveDerivativeShas(db.vault, ids, 'thumb');
  expect(map.size).toBe(550); // both chunks (500 + 50) folded into one map
  expect(map.get('c0')).toBeDefined();
  expect(map.get('c549')).toBeDefined();
});

test('an empty id list is a no-op, no query run', () => {
  expect(resolveDerivativeShas(db.vault, [], 'thumb').size).toBe(0);
});
