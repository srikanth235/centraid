/*
 * GATEWAY_TEST_CONNECTION (issue #382) — the ConnectFlow "handshake ladder".
 * Wires the currently-orphaned `handshakeGateway` (version-handshake.ts) and
 * `fetchGatewayVaults`/`foldVaultsResponse` (gateway-vaults-core.ts) plus the
 * new ssh-host module through the pure fold functions in
 * `gateway-connectivity-core.ts`. Never throws — every failure is a failed
 * stage with a human-actionable detail, per the frozen IPC contract.
 */

import { handshakeGateway } from './version-handshake.js';
import { fetchGatewayVaults } from './gateway-vaults-core.js';
import { resolveGateway } from './gateway-store.js';
import { assertDirectUrlAllowed, TransportGuardError } from './transport.js';
import { sshStatus, sshVaultList, sshVersion, type SshHostProfile } from './ssh-host.js';
import {
  assembleReport,
  buildTicketReport,
  foldSshStatusStage,
  foldSshVaultsStage,
  foldSshVersionStages,
  foldUrlIdentityStages,
  foldVaultsStageFromHttp,
  reachGuardFailureStages,
  skippedSshStage,
  stage,
  type ConnectivityReport,
} from './gateway-connectivity-core.js';

export type { ConnectivityReport } from './gateway-connectivity-core.js';

export type TestConnectionInput =
  | { kind: 'url'; url: string; token?: string }
  | { kind: 'ticket'; ticket: string }
  | { kind: 'ssh'; destination: string; dataDir?: string }
  | { kind: 'gateway'; gatewayId: string };

/** Run the url/gateway ladder (reach → identify → auth → vaults) against a
 *  resolved base URL + token. Shared by `kind:'url'` and `kind:'gateway'`
 *  (the latter resolves its URL/token from the profile store first). */
async function testUrl(url: string, token: string | undefined): Promise<ConnectivityReport> {
  try {
    assertDirectUrlAllowed(url);
  } catch (err) {
    const message = err instanceof TransportGuardError ? err.message : String(err);
    return assembleReport(reachGuardFailureStages(message), { error: 'guard_rejected' });
  }

  const handshake = await handshakeGateway(url, token);
  const identity = foldUrlIdentityStages(handshake);
  const authStage = identity.stages.find((st) => st.id === 'auth');

  // Only attempt the vaults read once reach + auth both passed — identify
  // failing (a version mismatch) doesn't block browsing vaults, but an
  // unreachable host or a rejected token does.
  if (authStage?.status !== 'pass') {
    return assembleReport([...identity.stages, stage('vaults', 'List vaults', 'skip')], {
      ...(identity.gateway ? { gateway: identity.gateway } : {}),
      ...(identity.errorCode ? { error: identity.errorCode } : {}),
    });
  }

  const vaultsResult = await fetchGatewayVaults(url, token);
  const folded = foldVaultsStageFromHttp(vaultsResult);
  return assembleReport([...identity.stages, folded.stage], {
    ...(identity.gateway ? { gateway: identity.gateway } : {}),
    ...(folded.vaults ? { vaults: folded.vaults } : {}),
    ...(identity.errorCode
      ? { error: identity.errorCode }
      : folded.errorCode
        ? { error: folded.errorCode }
        : {}),
  });
}

/** Run the ssh ladder (ssh → cli → daemon → vaults), skipping each
 *  subsequent stage once an earlier one fails. */
async function testSsh(profile: SshHostProfile): Promise<ConnectivityReport> {
  const versionResult = await sshVersion(profile);
  const versionFold = foldSshVersionStages(versionResult);

  if (versionFold.cli.status !== 'pass') {
    return assembleReport(
      [versionFold.ssh, versionFold.cli, skippedSshStage('daemon'), skippedSshStage('vaults')],
      versionFold.errorCode ? { error: versionFold.errorCode } : {},
    );
  }

  const statusResult = await sshStatus(profile);
  const statusFold = foldSshStatusStage(statusResult);
  if (statusFold.stage.status !== 'pass') {
    return assembleReport(
      [versionFold.ssh, versionFold.cli, statusFold.stage, skippedSshStage('vaults')],
      statusFold.errorCode ? { error: statusFold.errorCode } : {},
    );
  }

  const vaultsResult = await sshVaultList(profile);
  const vaultsFold = foldSshVaultsStage(vaultsResult);
  return assembleReport([versionFold.ssh, versionFold.cli, statusFold.stage, vaultsFold.stage], {
    ...(vaultsFold.vaults ? { vaults: vaultsFold.vaults } : {}),
    ...(vaultsFold.errorCode ? { error: vaultsFold.errorCode } : {}),
  });
}

export async function testGatewayConnection(
  input: TestConnectionInput,
): Promise<ConnectivityReport> {
  try {
    switch (input.kind) {
      case 'url':
        return await testUrl(input.url, input.token);

      case 'ticket':
        return buildTicketReport(input.ticket);

      case 'ssh':
        return await testSsh({ destination: input.destination, dataDir: input.dataDir });

      case 'gateway': {
        const resolved = await resolveGateway(input.gatewayId);
        if (!resolved || !resolved.url) {
          return assembleReport(reachGuardFailureStages('Unknown or unreachable gateway.'), {
            error: 'unknown_gateway',
          });
        }
        return await testUrl(resolved.url, resolved.token || undefined);
      }

      default:
        return assembleReport([], { error: 'bad_input' });
    }
  } catch (err) {
    // Belt-and-suspenders: the contract promises this never throws even if
    // something upstream (a store read, a malformed input) does.
    return assembleReport([], { error: err instanceof Error ? err.message : String(err) });
  }
}
