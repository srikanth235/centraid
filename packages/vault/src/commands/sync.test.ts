// governance: allow-repo-hygiene file-size-limit one suite over the whole sync command surface — staging consent (#290) and broker-credential lifecycle (#304) share the connection fixture, so the scenarios stay together
// The one-shot pull consent story (issue #290 phase 3): an agent stages
// parsed rows freely (risk low), but PUBLISHING them exceeds every agent's
// ceiling and parks for the owner — the pause between draft and send.

import { beforeEach, describe, expect, test } from 'vitest';
import {
  bootstrapVault,
  createGrant,
  enrollAgent,
  enrollDevice,
  type BootstrapResult,
} from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import { registerSyncCommands } from './sync.js';
import type { Credential } from '../gateway/types.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;
let agent: Credential;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerSyncCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
  const enrolled = enrollAgent(db, { name: 'gmail-pull', modelRef: 'model-x' });
  const device = enrollDevice(db, boot.ownerPartyId, 'agent-host');
  createGrant(db, {
    granteePartyId: enrolled.partyId,
    purposeConceptId: boot.concepts['dpv:ServiceProvision'] as string,
    grantedByPartyId: boot.ownerPartyId,
    scopes: [{ schema: 'sync', verbs: 'act' }],
  });
  agent = {
    kind: 'agent',
    agentId: enrolled.agentId,
    deviceId: device.deviceId,
    deviceKey: device.deviceKey,
  };
});

const ROWS = [
  {
    entity_type: 'core.event',
    external_id: 'gcal-evt-1',
    payload: {
      uid: 'gcal-evt-1',
      summary: 'Flight to Goa',
      description: null,
      dtstart: '2026-07-18T04:30:00Z',
      dtend: null,
      startTz: null,
      rrule: null,
      status: 'confirmed',
    },
  },
];

test('agent stages freely; publish parks; owner approval lands the rows', () => {
  const staged = gw.invoke(agent, {
    command: 'sync.stage_rows',
    input: { kind: 'pull.gcal', label: 'srikanth@crowdshakti.com', rows: ROWS },
    purpose: 'dpv:ServiceProvision',
  });
  expect(staged.status).toBe('executed');
  const batchId = (staged as { output: { batch_id: string } }).output.batch_id;

  // Nothing landed — staging is reviewable state.
  expect((db.vault.prepare('SELECT count(*) AS n FROM core_event').get() as { n: number }).n).toBe(
    0,
  );

  const publish = gw.invoke(agent, {
    command: 'sync.publish_batch',
    input: { batch_id: batchId },
    purpose: 'dpv:ServiceProvision',
  });
  expect(publish.status).toBe('parked'); // confirm-gated (issue #306): parks for every non-owner

  const confirmed = gw.confirm(owner, (publish as { invocationId: string }).invocationId, true);
  expect(confirmed.status).toBe('executed');
  expect((confirmed as { output: { created: number } }).output.created).toBe(1);
  const event = db.vault
    .prepare('SELECT summary FROM core_event WHERE ical_uid = ?')
    .get('gcal-evt-1') as { summary: string };
  expect(event.summary).toBe('Flight to Goa');
  // The map recorded the pull's identity — a re-stage skips.
  const again = gw.invoke(agent, {
    command: 'sync.stage_rows',
    input: { kind: 'pull.gcal', label: 'srikanth@crowdshakti.com', rows: ROWS },
    purpose: 'dpv:ServiceProvision',
  });
  expect((again as { output: { staged: { skip: number } } }).output.staged.skip).toBe(1);
});

test('owner denial keeps the vault untouched; the draft survives for later', () => {
  const staged = gw.invoke(agent, {
    command: 'sync.stage_rows',
    input: { kind: 'pull.gcal', label: 'work', rows: ROWS },
    purpose: 'dpv:ServiceProvision',
  });
  const batchId = (staged as { output: { batch_id: string } }).output.batch_id;
  const publish = gw.invoke(agent, {
    command: 'sync.publish_batch',
    input: { batch_id: batchId },
    purpose: 'dpv:ServiceProvision',
  });
  const denied = gw.confirm(owner, (publish as { invocationId: string }).invocationId, false);
  expect(denied.status).toBe('denied');
  expect((db.vault.prepare('SELECT count(*) AS n FROM core_event').get() as { n: number }).n).toBe(
    0,
  );
  const batch = db.vault
    .prepare('SELECT status FROM sync_import_batch WHERE batch_id = ?')
    .get(batchId) as { status: string };
  expect(batch.status).toBe('draft');
});

test('an unpublishable entity type is refused at staging time', () => {
  const outcome = gw.invoke(agent, {
    command: 'sync.stage_rows',
    input: {
      kind: 'pull.x',
      label: 'x',
      rows: [{ entity_type: 'health.vital', external_id: 'e1', payload: {} }],
    },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('failed');
  expect((outcome as { reason: string }).reason).toMatch(/no publisher/);
});

test('a sealed entity type never stages through an agent (issue #293)', () => {
  const outcome = gw.invoke(agent, {
    command: 'sync.stage_rows',
    input: {
      kind: 'pull.x',
      label: 'x',
      rows: [{ entity_type: 'locker.item', external_id: 'e1', payload: { title: 'x' } }],
    },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('failed');
  expect((outcome as { reason: string }).reason).toMatch(/sealed/);
});

test('the owner publishes directly — no parking above their ceiling', () => {
  const staged = gw.invoke(owner, {
    command: 'sync.stage_rows',
    input: { kind: 'pull.gcal', label: 'mine', rows: ROWS },
    purpose: 'dpv:ServiceProvision',
  });
  const batchId = (staged as { output: { batch_id: string } }).output.batch_id;
  const publish = gw.invoke(owner, {
    command: 'sync.publish_batch',
    input: { batch_id: batchId },
    purpose: 'dpv:ServiceProvision',
  });
  expect(publish.status).toBe('executed');
});

describe('connection lifecycle (phase 4)', () => {
  function beginRun(principal?: string) {
    return gw.invoke(agent, {
      command: 'sync.begin_run',
      input: { kind: 'mcp.gmail', label: 'personal', ...(principal ? { principal } : {}) },
      purpose: 'dpv:ServiceProvision',
    });
  }

  test('first run pins the principal; a mismatch flips needs-auth and refuses', () => {
    const first = beginRun('me@example.com');
    expect(first.status).toBe('executed');
    const runId = (first as { output: { run_id: string } }).output.run_id;
    const finish = gw.invoke(agent, {
      command: 'sync.finish_run',
      input: { run_id: runId, ok: true, staged: 3 },
      purpose: 'dpv:ServiceProvision',
    });
    expect(finish.status).toBe('executed');

    // The mismatch REFUSES via output (not a thrown rollback — the
    // needs-auth flip must survive the invocation).
    const wrong = beginRun('other@example.com');
    expect(wrong.status).toBe('executed');
    expect((wrong as { output: { refused: string } }).output.refused).toBe('principal-mismatch');
    const conn = db.vault
      .prepare(`SELECT status, principal FROM sync_connection WHERE kind = 'mcp.gmail'`)
      .get() as { status: string; principal: string };
    expect(conn).toEqual({ status: 'needs-auth', principal: 'me@example.com' });

    // A matching re-auth restores the connection to active.
    const recovered = beginRun('me@example.com');
    expect(recovered.status).toBe('executed');
    expect((recovered as { output: { run_id?: string } }).output.run_id).toBeTruthy();
    const after = db.vault
      .prepare(`SELECT status FROM sync_connection WHERE kind = 'mcp.gmail'`)
      .get() as { status: string };
    expect(after.status).toBe('active');
  });

  test('a failed run flips the connection to failing; a good one restores it', () => {
    const first = beginRun('me@example.com');
    const runId = (first as { output: { run_id: string } }).output.run_id;
    gw.invoke(agent, {
      command: 'sync.finish_run',
      input: { run_id: runId, ok: false, error: 'rate limited' },
      purpose: 'dpv:ServiceProvision',
    });
    const failing = db.vault
      .prepare(`SELECT status FROM sync_connection WHERE kind = 'mcp.gmail'`)
      .get() as { status: string };
    expect(failing.status).toBe('failing');
    const run = db.vault
      .prepare('SELECT status, error FROM sync_connection_run WHERE run_id = ?')
      .get(runId) as { status: string; error: string };
    expect(run).toEqual({ status: 'failed', error: 'rate limited' });
  });

  test('paused means paused — begin_run refuses until the owner resumes', () => {
    const first = beginRun('me@example.com');
    const connectionId = (first as { output: { connection_id: string } }).output.connection_id;
    const pause = gw.invoke(owner, {
      command: 'sync.set_connection_status',
      input: { connection_id: connectionId, status: 'paused' },
      purpose: 'dpv:ServiceProvision',
    });
    expect(pause.status).toBe('executed');
    const refused = beginRun('me@example.com');
    expect(refused.status).toBe('executed');
    expect((refused as { output: { refused: string } }).output.refused).toBe('paused');
    gw.invoke(owner, {
      command: 'sync.set_connection_status',
      input: { connection_id: connectionId, status: 'active' },
      purpose: 'dpv:ServiceProvision',
    });
    expect(beginRun('me@example.com').status).toBe('executed');
  });

  test('cursors persist across runs and come back on begin_run', () => {
    const first = beginRun('me@example.com');
    const connectionId = (first as { output: { connection_id: string } }).output.connection_id;
    const set = gw.invoke(agent, {
      command: 'sync.set_cursor',
      input: { connection_id: connectionId, key: 'history_id', value: { id: 42017 } },
      purpose: 'dpv:ServiceProvision',
    });
    expect(set.status).toBe('executed');
    const next = beginRun('me@example.com');
    expect((next as { output: { cursors: Record<string, unknown> } }).output.cursors).toEqual({
      history_id: { id: 42017 },
    });
  });
});

// ── Broker-owned credentials (issue #304) ────────────────────────────────

describe('sync.configure_credential + sync.store_tokens (issue #304)', () => {
  test('oauth2 configure seals the client secret, pins hosts, starts in needs-auth', () => {
    const outcome = gw.invoke(owner, {
      command: 'sync.configure_credential',
      input: {
        kind: 'pull.gmail',
        label: 'personal',
        cred_kind: 'oauth2',
        provider: 'google',
        auth_url: 'https://accounts.google.com/o/oauth2/v2/auth',
        token_url: 'https://oauth2.googleapis.com/token',
        scopes: 'https://www.googleapis.com/auth/gmail.readonly',
        client_id: 'abc.apps.googleusercontent.com',
        client_secret: 'GOCSPX-super-secret',
        allowed_hosts: ['gmail.googleapis.com', '*.googleapis.com'],
      },
      purpose: 'dpv:ServiceProvision',
    });
    expect(outcome.status).toBe('executed');
    expect((outcome as { output: { status: string } }).output.status).toBe('needs-auth');

    const cred = db.vault
      .prepare('SELECT cred_kind, client_secret, allowed_hosts FROM sync_connection_credential')
      .get() as { cred_kind: string; client_secret: string; allowed_hosts: string };
    expect(cred.cred_kind).toBe('oauth2');
    // Sealed at rest — never the plaintext.
    expect(cred.client_secret).toMatch(/^sealed:v1:/);
    expect(cred.client_secret).not.toContain('GOCSPX');
    expect(JSON.parse(cred.allowed_hosts)).toEqual(['gmail.googleapis.com', '*.googleapis.com']);
    const conn = db.vault.prepare('SELECT status FROM sync_connection').get() as {
      status: string;
    };
    expect(conn.status).toBe('needs-auth');
    const health = db.vault.prepare('SELECT auth_note FROM sync_connection_health').get() as {
      auth_note: string;
    };
    expect(health.auth_note).toMatch(/authorization pending/);
  });

  test('a credential without allowed_hosts refuses to configure (anti-exfiltration pin)', () => {
    const outcome = gw.invoke(owner, {
      command: 'sync.configure_credential',
      input: {
        kind: 'pull.github',
        label: 'personal',
        cred_kind: 'api_key',
        api_key: 'ghp_secret',
      },
      purpose: 'dpv:ServiceProvision',
    });
    expect(outcome.status).toBe('failed');
    expect((outcome as { reason: string }).reason).toMatch(/allowed_hosts/);
  });

  test('api_key configure seals the key and the connection is live immediately', () => {
    const outcome = gw.invoke(owner, {
      command: 'sync.configure_credential',
      input: {
        kind: 'pull.github',
        label: 'personal',
        cred_kind: 'api_key',
        provider: 'github',
        api_key: 'ghp_live_key',
        allowed_hosts: ['api.github.com'],
      },
      purpose: 'dpv:ServiceProvision',
    });
    expect(outcome.status).toBe('executed');
    const cred = db.vault.prepare('SELECT api_key FROM sync_connection_credential').get() as {
      api_key: string;
    };
    expect(cred.api_key).toMatch(/^sealed:v1:/);
    const conn = db.vault.prepare('SELECT status FROM sync_connection').get() as {
      status: string;
    };
    expect(conn.status).toBe('active');
  });

  test('store_tokens seals the pair, keeps the old refresh token when not rotated, and revives the connection', () => {
    gw.invoke(owner, {
      command: 'sync.configure_credential',
      input: {
        kind: 'pull.gmail',
        label: 'personal',
        cred_kind: 'oauth2',
        auth_url: 'https://a.example/auth',
        token_url: 'https://a.example/token',
        client_id: 'cid',
        allowed_hosts: ['gmail.googleapis.com'],
      },
      purpose: 'dpv:ServiceProvision',
    });
    const connectionId = (
      db.vault.prepare('SELECT connection_id FROM sync_connection').get() as {
        connection_id: string;
      }
    ).connection_id;

    const first = gw.invoke(owner, {
      command: 'sync.store_tokens',
      input: {
        connection_id: connectionId,
        access_token: 'ya29.first',
        refresh_token: '1//refresh-original',
        expires_at: '2026-07-06T13:00:00Z',
      },
      purpose: 'dpv:ServiceProvision',
    });
    expect(first.status).toBe('executed');
    let row = db.vault
      .prepare('SELECT access_token, refresh_token FROM sync_connection_credential')
      .get() as { access_token: string; refresh_token: string };
    expect(row.access_token).toMatch(/^sealed:v1:/);
    expect(row.refresh_token).toMatch(/^sealed:v1:/);
    expect(
      (db.vault.prepare('SELECT status FROM sync_connection').get() as { status: string }).status,
    ).toBe('active');
    // A revived connection carries no stale complaint.
    expect(db.vault.prepare('SELECT auth_note FROM sync_connection_health').get()).toBeUndefined();
    const originalRefreshCipher = row.refresh_token;

    // A non-rotating refresh: no refresh_token in the response.
    const second = gw.invoke(owner, {
      command: 'sync.store_tokens',
      input: {
        connection_id: connectionId,
        access_token: 'ya29.second',
        expires_at: '2026-07-06T14:00:00Z',
      },
      purpose: 'dpv:ServiceProvision',
    });
    expect(second.status).toBe('executed');
    row = db.vault
      .prepare('SELECT access_token, refresh_token FROM sync_connection_credential')
      .get() as { access_token: string; refresh_token: string };
    expect(row.refresh_token).toBe(originalRefreshCipher);
    expect(row.access_token).toMatch(/^sealed:v1:/);
  });

  test('store_tokens refuses a connection that is not oauth2-kind', () => {
    const connectionId = (
      gw.invoke(owner, {
        command: 'sync.configure_credential',
        input: {
          kind: 'pull.github',
          label: 'personal',
          cred_kind: 'api_key',
          api_key: 'ghp_x',
          allowed_hosts: ['api.github.com'],
        },
        purpose: 'dpv:ServiceProvision',
      }) as { output: { connection_id: string } }
    ).output.connection_id;
    const outcome = gw.invoke(owner, {
      command: 'sync.store_tokens',
      input: { connection_id: connectionId, access_token: 'ya29.x' },
      purpose: 'dpv:ServiceProvision',
    });
    expect(outcome.status).toBe('failed');
  });

  test('default reads show placeholders for every credential cell, and the journal holds no plaintext', () => {
    gw.invoke(owner, {
      command: 'sync.configure_credential',
      input: {
        kind: 'pull.gmail',
        label: 'personal',
        cred_kind: 'oauth2',
        auth_url: 'https://a.example/auth',
        token_url: 'https://a.example/token',
        client_id: 'cid',
        client_secret: 'GOCSPX-journal-check',
        allowed_hosts: ['gmail.googleapis.com'],
      },
      purpose: 'dpv:ServiceProvision',
    });
    const read = gw.read(owner, {
      entity: 'sync.connection_credential',
      purpose: 'dpv:ServiceProvision',
    });
    const row = read.rows[0] as Record<string, unknown>;
    expect(row.client_secret).toBe('«sealed»');
    expect(row.cred_kind).toBe('oauth2');

    // The append-only journal never carries the plaintext (sealedInput).
    const journal = db.journal
      .prepare('SELECT input_json FROM agent_command_invocation ORDER BY rowid DESC LIMIT 1')
      .get() as { input_json: string };
    expect(journal.input_json).not.toContain('GOCSPX-journal-check');
  });

  test('detaching (cred_kind none) shreds every credential cell', () => {
    gw.invoke(owner, {
      command: 'sync.configure_credential',
      input: {
        kind: 'pull.gmail',
        label: 'personal',
        cred_kind: 'oauth2',
        auth_url: 'https://a.example/auth',
        token_url: 'https://a.example/token',
        client_id: 'cid',
        client_secret: 'GOCSPX-x',
        allowed_hosts: ['gmail.googleapis.com'],
      },
      purpose: 'dpv:ServiceProvision',
    });
    gw.invoke(owner, {
      command: 'sync.configure_credential',
      input: { kind: 'pull.gmail', label: 'personal', cred_kind: 'none' },
      purpose: 'dpv:ServiceProvision',
    });
    expect(db.vault.prepare('SELECT * FROM sync_connection_credential').get()).toBeUndefined();
    expect(db.vault.prepare('SELECT * FROM sync_connection_health').get()).toBeUndefined();
    // The connection itself survives detachment.
    expect(db.vault.prepare('SELECT count(*) AS n FROM sync_connection').get()).toEqual({ n: 1 });
  });

  test('set_connection_status carries a note away from active and clears it on resume', () => {
    gw.invoke(owner, {
      command: 'sync.configure_credential',
      input: {
        kind: 'pull.github',
        label: 'personal',
        cred_kind: 'api_key',
        api_key: 'ghp_x',
        allowed_hosts: ['api.github.com'],
      },
      purpose: 'dpv:ServiceProvision',
    });
    const connectionId = (
      db.vault.prepare('SELECT connection_id FROM sync_connection').get() as {
        connection_id: string;
      }
    ).connection_id;
    gw.invoke(owner, {
      command: 'sync.set_connection_status',
      input: {
        connection_id: connectionId,
        status: 'needs-auth',
        note: 'token refresh refused (invalid_grant)',
      },
      purpose: 'dpv:ServiceProvision',
    });
    let status = (
      db.vault.prepare('SELECT status FROM sync_connection').get() as { status: string }
    ).status;
    expect(status).toBe('needs-auth');
    expect(
      (
        db.vault.prepare('SELECT auth_note FROM sync_connection_health').get() as {
          auth_note: string;
        }
      ).auth_note,
    ).toMatch(/invalid_grant/);
    gw.invoke(owner, {
      command: 'sync.set_connection_status',
      input: { connection_id: connectionId, status: 'active' },
      purpose: 'dpv:ServiceProvision',
    });
    status = (db.vault.prepare('SELECT status FROM sync_connection').get() as { status: string })
      .status;
    expect(status).toBe('active');
    expect(db.vault.prepare('SELECT auth_note FROM sync_connection_health').get()).toBeUndefined();
  });
});

// Issue #308 A1/A2: post-#306 only `confirm: true` parks — risk never does.
// The credential-touching pair must park for every non-owner caller, because
// `allowed_hosts` is #304's structural pin and the token pair is what every
// drain rides. The needs-auth honesty flip stays unparked (deliberate).
describe('credential commands are confirm-gated (issue #308 A1/A2)', () => {
  test('an agent proposing configure_credential parks; owner approval lands it', () => {
    const proposed = gw.invoke(agent, {
      command: 'sync.configure_credential',
      input: {
        kind: 'pull.gmail',
        label: 'personal',
        cred_kind: 'oauth2',
        auth_url: 'https://a.example/auth',
        token_url: 'https://a.example/token',
        client_id: 'cid',
        client_secret: 'GOCSPX-evil',
        allowed_hosts: ['attacker.example'],
      },
      purpose: 'dpv:ServiceProvision',
    });
    expect(proposed.status).toBe('parked');
    // Nothing moved while parked — the pin is untouched.
    expect(db.vault.prepare('SELECT * FROM sync_connection_credential').get()).toBeUndefined();
    const confirmed = gw.confirm(owner, (proposed as { invocationId: string }).invocationId, true);
    expect(confirmed.status).toBe('executed');
    expect(
      (
        db.vault.prepare('SELECT allowed_hosts FROM sync_connection_credential').get() as {
          allowed_hosts: string;
        }
      ).allowed_hosts,
    ).toContain('attacker.example');
  });

  test('an agent proposing store_tokens parks; the stored pair is untouched', () => {
    gw.invoke(owner, {
      command: 'sync.configure_credential',
      input: {
        kind: 'pull.gmail',
        label: 'personal',
        cred_kind: 'oauth2',
        auth_url: 'https://a.example/auth',
        token_url: 'https://a.example/token',
        client_id: 'cid',
        allowed_hosts: ['gmail.googleapis.com'],
      },
      purpose: 'dpv:ServiceProvision',
    });
    const connectionId = (
      db.vault.prepare('SELECT connection_id FROM sync_connection').get() as {
        connection_id: string;
      }
    ).connection_id;
    gw.invoke(owner, {
      command: 'sync.store_tokens',
      input: { connection_id: connectionId, access_token: 'ya29.owner' },
      purpose: 'dpv:ServiceProvision',
    });
    const proposed = gw.invoke(agent, {
      command: 'sync.store_tokens',
      input: { connection_id: connectionId, access_token: 'ya29.attacker' },
      purpose: 'dpv:ServiceProvision',
    });
    expect(proposed.status).toBe('parked');
    const denied = gw.confirm(owner, (proposed as { invocationId: string }).invocationId, false);
    expect(denied.status).toBe('denied');
  });

  test('the needs-auth flip stays unparked for agent callers (deliberately open)', () => {
    gw.invoke(owner, {
      command: 'sync.configure_credential',
      input: {
        kind: 'pull.github',
        label: 'personal',
        cred_kind: 'api_key',
        api_key: 'ghp_x',
        allowed_hosts: ['api.github.com'],
      },
      purpose: 'dpv:ServiceProvision',
    });
    const connectionId = (
      db.vault.prepare('SELECT connection_id FROM sync_connection').get() as {
        connection_id: string;
      }
    ).connection_id;
    const flipped = gw.invoke(agent, {
      command: 'sync.set_connection_status',
      input: { connection_id: connectionId, status: 'needs-auth', note: 'secret item trashed' },
      purpose: 'dpv:ServiceProvision',
    });
    expect(flipped.status).toBe('executed');
  });
});
