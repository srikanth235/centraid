import { describe, expect, it } from 'vitest';
import {
  buildTestInput,
  canCommitConnectFlow,
  canStartTest,
  connectFlowReducer,
  createInitialConnectFlowState,
  vaultCapability,
  type ConnectFlowState,
} from './connectFlow-core.js';

const at = (patch: Partial<ConnectFlowState>): ConnectFlowState => ({
  ...createInitialConnectFlowState(),
  ...patch,
});

describe('connectFlowReducer', () => {
  it('selectMethod(local) skips straight to the vault step', () => {
    const s = connectFlowReducer(createInitialConnectFlowState(), {
      method: 'local',
      type: 'selectMethod',
    });
    expect(s.step).toBe('vault');
    expect(s.method).toBe('local');
  });

  it('selectMethod(gateway|ssh) lands on details', () => {
    for (const method of ['gateway', 'ssh'] as const) {
      const s = connectFlowReducer(createInitialConnectFlowState(), {
        method,
        type: 'selectMethod',
      });
      expect(s.step).toBe('details');
    }
  });

  it('selectMethod resets any state left over from a prior method', () => {
    const dirty = at({ method: 'gateway', step: 'test', ticket: 'stale' });
    const s = connectFlowReducer(dirty, { method: 'ssh', type: 'selectMethod' });
    expect(s.ticket).toBe('');
    expect(s.step).toBe('details');
  });

  it('setField updates the named field only', () => {
    const s = connectFlowReducer(createInitialConnectFlowState(), {
      field: 'ticket',
      type: 'setField',
      value: 'abc',
    });
    expect(s.ticket).toBe('abc');
    expect(s.url).toBe('');
  });

  it('startTest moves to the test step and clears the previous report', () => {
    const withReport = at({ report: { ok: true, stages: [] }, step: 'details' });
    const s = connectFlowReducer(withReport, { type: 'startTest' });
    expect(s.step).toBe('test');
    expect(s.testing).toBe(true);
    expect(s.report).toBeNull();
  });

  it('testSettled records the report and clears testing', () => {
    const testing = at({ step: 'test', testing: true });
    const report = {
      ok: true,
      stages: [{ detail: 'v0.5', id: 'reach' as const, label: 'Reach', status: 'pass' as const }],
    };
    const s = connectFlowReducer(testing, { report, type: 'testSettled' });
    expect(s.testing).toBe(false);
    expect(s.report).toEqual(report);
  });

  it('continueToVault defaults to the first reported existing vault', () => {
    const withVaults = at({
      report: {
        ok: true,
        stages: [],
        vaults: [
          { name: 'A', vaultId: 'a' },
          { name: 'B', vaultId: 'b' },
        ],
      },
      step: 'test',
    });
    const s = connectFlowReducer(withVaults, { type: 'continueToVault' });
    expect(s.step).toBe('vault');
    expect(s.vaultChoice).toEqual({ kind: 'existing', vaultId: 'a' });
  });

  it('continueToVault defaults to "create" for a create-capable method with no reported vaults', () => {
    const sshNoVaults = at({ method: 'ssh', report: { ok: true, stages: [] }, step: 'test' });
    const s = connectFlowReducer(sshNoVaults, { type: 'continueToVault' });
    expect(s.vaultChoice).toEqual({ kind: 'create' });
  });

  it('continueToVault leaves vaultChoice null for a ticket connect (locked, not a real choice)', () => {
    const ticket = at({
      method: 'gateway',
      report: {
        ok: true,
        stages: [],
        ticket: { expiresAt: '', gatewayEndpointId: '', vaultName: 'Home' },
      },
      step: 'test',
    });
    const s = connectFlowReducer(ticket, { type: 'continueToVault' });
    expect(s.vaultChoice).toBeNull();
  });

  it('back from details clears the method and returns to method', () => {
    const s = connectFlowReducer(at({ method: 'gateway', step: 'details', ticket: 'x' }), {
      type: 'back',
    });
    expect(s.step).toBe('method');
    expect(s.method).toBeNull();
  });

  it('back from test returns to details, keeping the method', () => {
    const s = connectFlowReducer(at({ method: 'gateway', step: 'test' }), { type: 'back' });
    expect(s.step).toBe('details');
    expect(s.method).toBe('gateway');
  });

  it('back from vault for a local method returns straight to method (skips details/test)', () => {
    const s = connectFlowReducer(at({ method: 'local', step: 'vault' }), { type: 'back' });
    expect(s.step).toBe('method');
  });

  it('back from vault for a gateway method returns to test, keeping the report', () => {
    const report = { ok: true, stages: [] };
    const s = connectFlowReducer(at({ method: 'gateway', report, step: 'vault' }), {
      type: 'back',
    });
    expect(s.step).toBe('test');
    expect(s.report).toEqual(report);
  });

  it('back from the error step returns to vault so the user can retry', () => {
    const s = connectFlowReducer(at({ commitError: 'boom', method: 'ssh', step: 'error' }), {
      type: 'back',
    });
    expect(s.step).toBe('vault');
    expect(s.commitError).toBeNull();
  });

  it('commit -> commitSettled reaches done with the result', () => {
    let s = connectFlowReducer(createInitialConnectFlowState(), { type: 'commit' });
    expect(s.step).toBe('committing');
    expect(s.committing).toBe(true);
    s = connectFlowReducer(s, {
      result: { displayLabel: 'Home', gatewayId: 'gw1', vaultId: 'v1' },
      type: 'commitSettled',
    });
    expect(s.step).toBe('done');
    expect(s.committing).toBe(false);
    expect(s.result).toEqual({ displayLabel: 'Home', gatewayId: 'gw1', vaultId: 'v1' });
  });

  it('commitFailed reaches the error step with the message', () => {
    const s = connectFlowReducer(at({ committing: true, step: 'committing' }), {
      error: 'unreachable',
      type: 'commitFailed',
    });
    expect(s.step).toBe('error');
    expect(s.commitError).toBe('unreachable');
  });

  it('reset returns to the initial state', () => {
    const dirty = at({ method: 'ssh', step: 'vault', ticket: 'x' });
    expect(connectFlowReducer(dirty, { type: 'reset' })).toEqual(createInitialConnectFlowState());
  });
});

describe('buildTestInput / canStartTest', () => {
  it('is null with nothing filled in', () => {
    expect(buildTestInput(createInitialConnectFlowState())).toBeNull();
    expect(canStartTest(createInitialConnectFlowState())).toBe(false);
  });

  it('gateway/ticket mode: {kind:"ticket"} once a ticket is present', () => {
    const s = at({ method: 'gateway', ticket: '  t.icket  ' });
    expect(buildTestInput(s)).toEqual({ kind: 'ticket', ticket: 't.icket' });
  });

  it('gateway/token mode requires both url and token', () => {
    const partial = at({
      advancedOpen: true,
      credMode: 'token',
      method: 'gateway',
      url: 'https://x',
    });
    expect(buildTestInput(partial)).toBeNull();
    const full = at({ ...partial, token: 'sekret' });
    expect(buildTestInput(full)).toEqual({ kind: 'url', token: 'sekret', url: 'https://x' });
  });

  it('ssh: destination required, dataDir optional', () => {
    const s = at({ method: 'ssh', sshDestination: 'user@host' });
    expect(buildTestInput(s)).toEqual({
      dataDir: undefined,
      destination: 'user@host',
      kind: 'ssh',
    });
    const withDir = at({ method: 'ssh', sshDataDir: '/data', sshDestination: 'user@host' });
    expect(buildTestInput(withDir)).toEqual({
      dataDir: '/data',
      destination: 'user@host',
      kind: 'ssh',
    });
  });
});

describe('vaultCapability', () => {
  it('local: create-capable, no lock', () => {
    const cap = vaultCapability(at({ method: 'local' }));
    expect(cap).toEqual({ canCreate: true, locked: null, options: [] });
  });

  it('ssh: create-capable, options come from the report', () => {
    const cap = vaultCapability(
      at({
        method: 'ssh',
        report: { ok: true, stages: [], vaults: [{ name: 'A', vaultId: 'a' }] },
      }),
    );
    expect(cap).toEqual({ canCreate: true, locked: null, options: [{ name: 'A', vaultId: 'a' }] });
  });

  it('gateway/ticket: locked to the ticket vault name, not create-capable', () => {
    const cap = vaultCapability(
      at({
        method: 'gateway',
        report: {
          ok: true,
          stages: [],
          ticket: { expiresAt: '', gatewayEndpointId: '', vaultName: 'Office' },
        },
      }),
    );
    expect(cap).toEqual({ canCreate: false, locked: { vaultName: 'Office' }, options: [] });
  });

  it('gateway/token: pick-only from report.vaults, not create-capable', () => {
    const cap = vaultCapability(
      at({
        advancedOpen: true,
        credMode: 'token',
        method: 'gateway',
        report: { ok: true, stages: [], vaults: [{ name: 'A', vaultId: 'a' }] },
      }),
    );
    expect(cap).toEqual({ canCreate: false, locked: null, options: [{ name: 'A', vaultId: 'a' }] });
  });
});

describe('canCommitConnectFlow', () => {
  it('local requires a vault choice, and a name when creating', () => {
    expect(canCommitConnectFlow(at({ method: 'local' }))).toBe(false);
    expect(
      canCommitConnectFlow(
        at({ method: 'local', vaultChoice: { kind: 'existing', vaultId: 'a' } }),
      ),
    ).toBe(true);
    expect(canCommitConnectFlow(at({ method: 'local', vaultChoice: { kind: 'create' } }))).toBe(
      false,
    );
    expect(
      canCommitConnectFlow(
        at({ method: 'local', newVaultName: 'Mine', vaultChoice: { kind: 'create' } }),
      ),
    ).toBe(true);
  });

  it('gateway/ticket requires a non-empty ticket', () => {
    expect(canCommitConnectFlow(at({ method: 'gateway' }))).toBe(false);
    expect(canCommitConnectFlow(at({ method: 'gateway', ticket: 't' }))).toBe(true);
  });

  it('gateway/token requires both url and token', () => {
    const s = at({ advancedOpen: true, credMode: 'token', method: 'gateway' });
    expect(canCommitConnectFlow(s)).toBe(false);
    expect(canCommitConnectFlow({ ...s, token: 't', url: 'https://x' })).toBe(true);
  });

  it('ssh requires a destination and a resolved vault choice', () => {
    expect(canCommitConnectFlow(at({ method: 'ssh' }))).toBe(false);
    expect(canCommitConnectFlow(at({ method: 'ssh', sshDestination: 'user@host' }))).toBe(false);
    expect(
      canCommitConnectFlow(
        at({
          method: 'ssh',
          sshDestination: 'user@host',
          vaultChoice: { kind: 'existing', vaultId: 'a' },
        }),
      ),
    ).toBe(true);
    expect(
      canCommitConnectFlow(
        at({ method: 'ssh', sshDestination: 'user@host', vaultChoice: { kind: 'create' } }),
      ),
    ).toBe(false);
    expect(
      canCommitConnectFlow(
        at({
          method: 'ssh',
          newVaultName: 'Mine',
          sshDestination: 'user@host',
          vaultChoice: { kind: 'create' },
        }),
      ),
    ).toBe(true);
  });
});
