import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createBrokerHealthProbe } from './broker-health.js';

/** A minimal in-memory `sync_connection*` trio — just enough for the probe's join. */
function fakeVaultDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sync_connection (
      connection_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE sync_connection_credential (
      connection_id TEXT PRIMARY KEY,
      cred_kind TEXT NOT NULL,
      token_expires_at TEXT
    );
    CREATE TABLE sync_connection_health (
      connection_id TEXT PRIMARY KEY,
      auth_note TEXT
    );
  `);
  return db;
}

function insertConnection(
  db: DatabaseSync,
  row: {
    id: string;
    label: string;
    status: string;
    credKind: 'oauth2' | 'api_key';
    tokenExpiresAt?: string;
    authNote?: string;
  },
): void {
  db.prepare(`INSERT INTO sync_connection (connection_id, label, status) VALUES (?, ?, ?)`).run(
    row.id,
    row.label,
    row.status,
  );
  db.prepare(
    `INSERT INTO sync_connection_credential (connection_id, cred_kind, token_expires_at) VALUES (?, ?, ?)`,
  ).run(row.id, row.credKind, row.tokenExpiresAt ?? null);
  if (row.authNote) {
    db.prepare(`INSERT INTO sync_connection_health (connection_id, auth_note) VALUES (?, ?)`).run(
      row.id,
      row.authNote,
    );
  }
}

describe('createBrokerHealthProbe', () => {
  it('reports ok when there are no broker-carried connections', async () => {
    const probe = createBrokerHealthProbe({ vaults: () => [{ vaultId: 'v1', db: fakeVaultDb() }] });
    const result = await probe();
    expect(result.status).toBe('ok');
  });

  it('reports ok for a healthy oauth2 connection with a live token', async () => {
    const db = fakeVaultDb();
    insertConnection(db, {
      id: 'c1',
      label: 'gmail',
      status: 'active',
      credKind: 'oauth2',
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const probe = createBrokerHealthProbe({ vaults: () => [{ vaultId: 'v1', db }] });
    expect((await probe()).status).toBe('ok');
  });

  it("flags a needs-auth connection with the broker's recorded reason", async () => {
    const db = fakeVaultDb();
    insertConnection(db, {
      id: 'c1',
      label: 'gmail',
      status: 'needs-auth',
      credKind: 'oauth2',
      authNote: 'token refresh refused (invalid_grant)',
    });
    const probe = createBrokerHealthProbe({ vaults: () => [{ vaultId: 'v1', db }] });
    const result = await probe();
    expect(result.status).toBe('degraded');
    expect(result.detail).toContain('need re-auth');
    expect(result.detail).toContain('gmail');
    expect(result.detail).toContain('invalid_grant');
  });

  it('flags an oauth2 token past expiry beyond the grace window as overdue', async () => {
    const db = fakeVaultDb();
    insertConnection(db, {
      id: 'c1',
      label: 'calendar',
      status: 'active', // broker hasn't touched it since expiry — nothing fired
      credKind: 'oauth2',
      tokenExpiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
    });
    const probe = createBrokerHealthProbe({
      vaults: () => [{ vaultId: 'v1', db }],
      overdueGraceMs: 60 * 60 * 1000, // 1h
    });
    const result = await probe();
    expect(result.status).toBe('degraded');
    expect(result.detail).toContain('token refresh overdue');
    expect(result.detail).toContain('calendar');
  });

  it('does not flag a token that expired only moments ago (inside the grace window)', async () => {
    const db = fakeVaultDb();
    insertConnection(db, {
      id: 'c1',
      label: 'calendar',
      status: 'active',
      credKind: 'oauth2',
      tokenExpiresAt: new Date(Date.now() - 5_000).toISOString(), // 5s ago
    });
    const probe = createBrokerHealthProbe({
      vaults: () => [{ vaultId: 'v1', db }],
      overdueGraceMs: 60 * 60 * 1000,
    });
    expect((await probe()).status).toBe('ok');
  });

  it('never flags api_key connections as overdue (nothing to refresh)', async () => {
    const db = fakeVaultDb();
    insertConnection(db, {
      id: 'c1',
      label: 'static-pat',
      status: 'active',
      credKind: 'api_key',
    });
    const probe = createBrokerHealthProbe({ vaults: () => [{ vaultId: 'v1', db }] });
    expect((await probe()).status).toBe('ok');
  });

  it('aggregates across multiple vaults', async () => {
    const dbA = fakeVaultDb();
    insertConnection(dbA, { id: 'c1', label: 'a-conn', status: 'needs-auth', credKind: 'oauth2' });
    const dbB = fakeVaultDb();
    insertConnection(dbB, { id: 'c2', label: 'b-conn', status: 'needs-auth', credKind: 'oauth2' });
    const probe = createBrokerHealthProbe({
      vaults: () => [
        { vaultId: 'vault-aaaa', db: dbA },
        { vaultId: 'vault-bbbb', db: dbB },
      ],
    });
    const result = await probe();
    expect(result.detail).toContain('2 need re-auth');
  });

  it('tolerates a vault whose sync tables are missing (fresh/unmounted plane)', async () => {
    const db = new DatabaseSync(':memory:'); // no tables at all
    const probe = createBrokerHealthProbe({ vaults: () => [{ vaultId: 'v1', db }] });
    await expect(probe()).resolves.toEqual({
      status: 'ok',
      detail: 'broker-carried connections healthy',
    });
  });
});
