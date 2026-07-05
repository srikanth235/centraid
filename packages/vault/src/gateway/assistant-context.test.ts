// The assistant's schema map: live DDL + the ontology conventions.
// Coverage is shape-level — the doc must carry the pieces the model needs
// (conventions, relations vocabulary, FTS surfaces, DDL) off a live file.

import { beforeEach, describe, expect, test } from 'vitest';
import { bootstrapVault } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { buildAssistantContext } from './assistant-context.js';

let db: VaultDb;

beforeEach(() => {
  db = openVaultDb();
  bootstrapVault(db, { ownerName: 'Priya' });
});

describe('buildAssistantContext', () => {
  test('carries conventions, vocabulary, FTS surfaces, and live DDL', () => {
    const doc = buildAssistantContext(db);
    expect(doc).toContain('core_link is the ONLY cross-entity relationship fabric');
    expect(doc).toContain('vault_content_text(');
    expect(doc).toContain('## Link relations');
    expect(doc).toContain('fts_knowledge_note');
    expect(doc).toContain('CREATE TABLE core_party');
    expect(doc).toContain('CREATE TABLE core_link');
    // FTS shadow internals stay out — they are noise for query authoring.
    expect(doc).not.toContain('fts_core_party_idx');
  });
});
