import { listVaults } from '../../../gateway-client.js';
import { connectGateway, friendlyGatewayError } from './gatewayModals.js';
import {
  isTokenMode,
  type ConnectFlowResult,
  type ConnectFlowState,
  type ConnectTestInput,
  type ConnectivityReport,
} from './connectFlow-core.js';

/*
 * Impure IO for ConnectFlow (issue #382) — mirrors the
 * flatVaultSwitcher-core.ts / flatVaultSwitcherRegistry.ts split: every
 * `window.CentraidApi` call and error-shape decision lives here, so
 * `connectFlow-core.ts` and the component stay pure/presentational.
 *
 * `testGatewayConnection` and `sshConnectGateway` are new IPC methods added
 * by the backend half of #382 (packages/gateway + apps/desktop/src/main +
 * preload.ts + centraid-api.d.ts), landing concurrently with this file. This
 * renderer half doesn't own centraid-api.d.ts, so the contract is declared
 * locally against the design doc rather than imported — `ConnectFlowBridge`
 * below is the exact shape the design doc specifies. A real integration
 * typecheck reconciles the two once both halves land; until then this file
 * (and its callers) type-check against this local contract, which Vitest's
 * esbuild transform doesn't need resolved against the real global anyway.
 */

export type SshVaultInput =
  | { kind: 'existing'; vaultId: string }
  | { kind: 'create'; name: string };

export interface SshConnectInput {
  destination: string;
  dataDir?: string;
  label?: string;
  rememberDevice?: boolean;
  vault: SshVaultInput;
}

export type SshConnectResult =
  | { ok: true; gatewayId: string; vaultId: string; vaultName: string }
  | { ok: false; error: string; message: string };

export interface ConnectFlowBridge {
  testGatewayConnection(input: ConnectTestInput): Promise<ConnectivityReport>;
  sshConnectGateway(input: SshConnectInput): Promise<SshConnectResult>;
}

function bridge(): ConnectFlowBridge {
  return window.CentraidApi as unknown as ConnectFlowBridge;
}

/** Run the connectivity test for the current details. Never throws — a
 *  bridge that's missing (older build, unwired test double) or a rejecting
 *  call both fold to a single failed 'reach' stage, same posture as
 *  `redeemGatewayPairing`'s `{ok:false}` contract. */
export async function runConnectivityTest(input: ConnectTestInput): Promise<ConnectivityReport> {
  try {
    const b = bridge();
    if (typeof b.testGatewayConnection !== 'function') {
      return {
        error: 'unavailable',
        ok: false,
        stages: [{ id: 'reach', label: 'Reach gateway', status: 'fail' }],
      };
    }
    return await b.testGatewayConnection(input);
  } catch (err) {
    return {
      error: 'unreachable',
      ok: false,
      stages: [
        {
          detail: err instanceof Error ? err.message : String(err),
          id: 'reach',
          label: 'Reach gateway',
          status: 'fail',
        },
      ],
    };
  }
}

/** The local gateway's existing vaults, shaped like a ConnectivityReport's
 *  `vaults[]` so the vault step's rendering stays method-agnostic. */
export async function loadLocalVaults(): Promise<ConnectivityReport['vaults']> {
  const vaults = await listVaults().catch(() => undefined);
  return (vaults ?? []).map((v) => ({
    color: v.color,
    icon: v.icon,
    name: v.name,
    vaultId: v.vaultId,
  }));
}

/**
 * Commit the flow (design doc step D). Throws with a user-facing message on
 * failure — the component catches it and dispatches `commitFailed`.
 */
export async function commitConnectFlow(state: ConnectFlowState): Promise<ConnectFlowResult> {
  if (state.method === 'local') {
    return commitLocal(state);
  }
  if (state.method === 'gateway') {
    return commitGateway(state);
  }
  if (state.method === 'ssh') {
    return commitSsh(state);
  }
  throw new Error('No connection method selected.');
}

async function ensureLocalGatewayActive(): Promise<void> {
  const settings = await window.CentraidApi.getSettings().catch(() => undefined);
  if (settings?.activeGatewayId !== 'local') {
    await window.CentraidApi.setActiveGateway({ id: 'local' });
  }
}

async function commitLocal(state: ConnectFlowState): Promise<ConnectFlowResult> {
  if (!state.vaultChoice) throw new Error('Pick or create a space first.');
  await ensureLocalGatewayActive();
  if (state.vaultChoice.kind === 'create') {
    const name = state.newVaultName.trim();
    const created = await window.CentraidApi.createVault({ name: name || undefined });
    await window.CentraidApi.setActiveVault({ vaultId: created.vaultId });
    return { displayLabel: 'This Mac', gatewayId: 'local', vaultId: created.vaultId };
  }
  const { vaultId } = state.vaultChoice;
  await window.CentraidApi.setActiveVault({ vaultId });
  return { displayLabel: 'This Mac', gatewayId: 'local', vaultId };
}

async function commitGateway(state: ConnectFlowState): Promise<ConnectFlowResult> {
  const label = state.label.trim() || undefined;
  const result = isTokenMode(state)
    ? await connectGateway({
        kind: 'token',
        label: label ?? state.url.trim(),
        token: state.token.trim(),
        url: state.url.trim(),
      })
    : await connectGateway(
        state.advancedOpen
          ? {
              kind: 'ticket-url',
              label,
              rememberDevice: state.rememberDevice,
              ticket: state.ticket.trim(),
              url: state.url.trim(),
            }
          : {
              kind: 'ticket',
              label,
              rememberDevice: state.rememberDevice,
              ticket: state.ticket.trim(),
            },
      );
  if (!result.ok) throw new Error(result.message);
  // Token connects only add + switch the gateway (no ticket payload naming a
  // vault) — if the user picked one of the admin plane's listed vaults,
  // follow up with the vault switch (gatewayModals.ts's contract note).
  if (isTokenMode(state) && state.vaultChoice?.kind === 'existing') {
    await window.CentraidApi.setActiveVault({ vaultId: state.vaultChoice.vaultId });
    return {
      displayLabel: result.label,
      gatewayId: result.gatewayId,
      vaultId: state.vaultChoice.vaultId,
    };
  }
  return { displayLabel: result.label, gatewayId: result.gatewayId, vaultId: result.vaultId ?? '' };
}

async function commitSsh(state: ConnectFlowState): Promise<ConnectFlowResult> {
  if (!state.vaultChoice) throw new Error('Pick or create a space first.');
  const vault: SshVaultInput =
    state.vaultChoice.kind === 'create'
      ? { kind: 'create', name: state.newVaultName.trim() }
      : { kind: 'existing', vaultId: state.vaultChoice.vaultId };
  const result = await bridge().sshConnectGateway({
    dataDir: state.sshDataDir.trim() || undefined,
    destination: state.sshDestination.trim(),
    label: state.label.trim() || undefined,
    rememberDevice: state.rememberDevice,
    vault,
  });
  if (!result.ok) throw new Error(friendlyGatewayError(result.error, result.message));
  return {
    displayLabel: result.vaultName || result.gatewayId,
    gatewayId: result.gatewayId,
    vaultId: result.vaultId,
  };
}
