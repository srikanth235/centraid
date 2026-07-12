import { describe, expect, it } from 'vitest';
import {
  assembleReport,
  buildTicketReport,
  foldSshStatusStage,
  foldSshVaultsStage,
  foldSshVersionStages,
  foldUrlIdentityStages,
  foldVaultsStageFromHttp,
  reachGuardFailureStages,
  stage,
} from './gateway-connectivity-core.js';
import { EXPECTED_GATEWAY_VERSION, EXPECTED_SCHEMA_EPOCH } from './version-handshake.js';

function encodeTicket(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

describe('assembleReport', () => {
  it('is ok when every stage passed (or was skipped)', () => {
    const report = assembleReport([
      stage('reach', 'Reach', 'pass'),
      stage('identify', 'ID', 'skip'),
    ]);
    expect(report.ok).toBe(true);
    expect(report.error).toBeUndefined();
  });

  it('is not ok when any stage failed, and carries the supplied error code', () => {
    const report = assembleReport([stage('reach', 'Reach', 'fail', 'boom')], {
      error: 'unreachable',
    });
    expect(report.ok).toBe(false);
    expect(report.error).toBe('unreachable');
  });

  it('drops gateway/vaults/ticket/error extras that were not supplied', () => {
    const report = assembleReport([stage('reach', 'Reach', 'pass')]);
    expect(report).not.toHaveProperty('gateway');
    expect(report).not.toHaveProperty('vaults');
    expect(report).not.toHaveProperty('ticket');
    expect(report).not.toHaveProperty('error');
  });
});

describe('foldUrlIdentityStages', () => {
  it('passes all three on a matching handshake', () => {
    const result = foldUrlIdentityStages({
      ok: true,
      info: {
        version: EXPECTED_GATEWAY_VERSION,
        schemaEpoch: EXPECTED_SCHEMA_EPOCH,
        instanceId: 'inst-1',
      },
    });
    expect(result.stages.map((s) => [s.id, s.status])).toEqual([
      ['reach', 'pass'],
      ['identify', 'pass'],
      ['auth', 'pass'],
    ]);
    expect(result.gateway).toEqual({
      version: EXPECTED_GATEWAY_VERSION,
      schemaEpoch: EXPECTED_SCHEMA_EPOCH,
      instanceId: 'inst-1',
      compatible: true,
    });
  });

  it('fails reach (and skips the rest) when the fetch never got a response', () => {
    const result = foldUrlIdentityStages({
      ok: false,
      reason: 'unreachable',
      detail: 'ECONNREFUSED',
    });
    expect(result.stages.map((s) => [s.id, s.status])).toEqual([
      ['reach', 'fail'],
      ['identify', 'skip'],
      ['auth', 'skip'],
    ]);
    expect(result.errorCode).toBe('unreachable');
  });

  it('fails auth (reach passes) on a 401/403, skipping identify', () => {
    const result = foldUrlIdentityStages({ ok: false, reason: 'unreachable', detail: 'HTTP 401' });
    expect(result.stages.map((s) => [s.id, s.status])).toEqual([
      ['reach', 'pass'],
      ['identify', 'skip'],
      ['auth', 'fail'],
    ]);
    expect(result.errorCode).toBe('auth_failed');

    const forbidden = foldUrlIdentityStages({
      ok: false,
      reason: 'unreachable',
      detail: 'HTTP 403',
    });
    expect(forbidden.stages.find((s) => s.id === 'auth')?.status).toBe('fail');
  });

  it('fails identify (reach + auth pass) on a version mismatch', () => {
    const result = foldUrlIdentityStages({
      ok: false,
      reason: 'version_mismatch',
      detail: 'gateway is v9.9.9; this app expects v0.1.0',
    });
    expect(result.stages.map((s) => [s.id, s.status])).toEqual([
      ['reach', 'pass'],
      ['identify', 'fail'],
      ['auth', 'pass'],
    ]);
    expect(result.errorCode).toBe('version_mismatch');
  });

  it('fails identify on a non-401/403 HTTP error status (e.g. 500)', () => {
    const result = foldUrlIdentityStages({ ok: false, reason: 'unreachable', detail: 'HTTP 500' });
    expect(result.stages.map((s) => [s.id, s.status])).toEqual([
      ['reach', 'pass'],
      ['identify', 'fail'],
      ['auth', 'pass'],
    ]);
  });
});

describe('foldVaultsStageFromHttp', () => {
  it('passes and maps vault rows on success', () => {
    const result = foldVaultsStageFromHttp({
      ok: true,
      vaults: [{ vaultId: 'v1', name: 'Family', color: '#fff' }],
    });
    expect(result.stage.status).toBe('pass');
    expect(result.vaults).toEqual([{ vaultId: 'v1', name: 'Family', color: '#fff' }]);
  });

  it('fails with a distinct detail per error code', () => {
    expect(foldVaultsStageFromHttp({ ok: false, error: 'auth_failed' }).stage.detail).toMatch(
      /token/,
    );
    expect(foldVaultsStageFromHttp({ ok: false, error: 'unreachable' }).errorCode).toBe(
      'unreachable',
    );
  });
});

describe('reachGuardFailureStages', () => {
  it('fails reach and skips identify+auth', () => {
    const stages = reachGuardFailureStages('Refusing plain http:// to a public host.');
    expect(stages.map((s) => [s.id, s.status])).toEqual([
      ['reach', 'fail'],
      ['identify', 'skip'],
      ['auth', 'skip'],
    ]);
    expect(stages[0]?.detail).toContain('Refusing plain http');
  });
});

describe('buildTicketReport', () => {
  const now = Date.parse('2026-07-12T00:00:00Z');

  it('decodes a valid, unexpired ticket', () => {
    const raw = encodeTicket({
      v: 1,
      kind: 'centraid-gw-pair',
      gw: 'endpoint-ticket-string',
      t: 'ticket-id',
      s: 'secret',
      vaultName: 'Family',
      exp: now + 60_000,
    });
    const report = buildTicketReport(raw, now);
    expect(report.ok).toBe(true);
    expect(report.stages).toEqual([{ id: 'decode', label: 'Decode ticket', status: 'pass' }]);
    expect(report.ticket).toEqual({
      vaultName: 'Family',
      expiresAt: new Date(now + 60_000).toISOString(),
      gatewayEndpointId: 'endpoint-ticket-string',
    });
  });

  it('reports invalid_ticket for garbage input', () => {
    const report = buildTicketReport('not-a-real-ticket', now);
    expect(report.ok).toBe(false);
    expect(report.error).toBe('invalid_ticket');
    expect(report.stages[0]?.status).toBe('fail');
  });

  it('reports ticket_expired for a stale ticket, without ever dialing', () => {
    const raw = encodeTicket({
      v: 1,
      kind: 'centraid-gw-pair',
      gw: 'endpoint-ticket-string',
      t: 'ticket-id',
      s: 'secret',
      vaultName: 'Family',
      exp: now - 1000,
    });
    const report = buildTicketReport(raw, now);
    expect(report.ok).toBe(false);
    expect(report.error).toBe('ticket_expired');
  });
});

describe('ssh-kind fold helpers', () => {
  it('foldSshVersionStages: success passes both ssh + cli, carrying the version in detail', () => {
    const result = foldSshVersionStages({ ok: true, value: '0.1.0' });
    expect(result.ssh).toEqual({ id: 'ssh', label: 'Reach host', status: 'pass' });
    expect(result.cli).toEqual({
      id: 'cli',
      label: 'centraid-gateway CLI',
      status: 'pass',
      detail: '0.1.0',
    });
  });

  it('foldSshVersionStages: cli_not_found still passes ssh (host was reachable)', () => {
    const result = foldSshVersionStages({
      ok: false,
      error: 'cli_not_found',
      message: 'bash: centraid-gateway: command not found',
    });
    expect(result.ssh.status).toBe('pass');
    expect(result.cli.status).toBe('fail');
    expect(result.errorCode).toBe('cli_not_found');
  });

  it('foldSshVersionStages: ssh_unreachable/ssh_auth fail ssh and skip cli', () => {
    for (const error of ['ssh_unreachable', 'ssh_auth'] as const) {
      const result = foldSshVersionStages({ ok: false, error, message: 'nope' });
      expect(result.ssh.status).toBe('fail');
      expect(result.cli.status).toBe('skip');
      expect(result.errorCode).toBe(error);
    }
  });

  it('foldSshStatusStage passes/fails on the daemon stage', () => {
    expect(foldSshStatusStage({ ok: true, value: { ok: true } }).stage.status).toBe('pass');
    const failed = foldSshStatusStage({ ok: false, error: 'daemon_error', message: 'boom' });
    expect(failed.stage.status).toBe('fail');
    expect(failed.errorCode).toBe('daemon_error');
  });

  it('foldSshVaultsStage maps well-formed rows and drops malformed ones', () => {
    const result = foldSshVaultsStage({
      ok: true,
      value: { vaults: [{ vaultId: 'v1', name: 'Family' }, { vaultId: 'v2' }, { garbage: true }] },
    });
    expect(result.stage.status).toBe('pass');
    expect(result.vaults).toEqual([{ vaultId: 'v1', name: 'Family' }]);
  });
});
