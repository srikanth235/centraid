/*
 * GATEWAY_SSH_CONNECT (issue #382) — the "Over SSH" ConnectFlow's commit
 * step, and the shared helper the ssh-routed VAULTS_CREATE (ipc.ts) reuses
 * for "create another vault on an already-ssh-capable gateway".
 *
 * Flow: (optional) `vault create --json` over ssh → `pair --vault <id>
 * --json --ttl-minutes 15` over ssh → redeem the returned ticket LOCALLY
 * through the EXISTING `redeemGatewayPairing` (gateway-pairing.ts, iroh
 * mode — device key = dial key invariant preserved, zero new enrollment
 * logic) → persist the `ssh` block onto the resulting profile so later
 * admin acts (mint another ticket, create another vault) can reach the box
 * again without re-asking for the destination. Never throws — every
 * failure resolves to `{ok:false, error, message}` with a stable code.
 */

import { sshPair, sshVaultCreate, type SshHostProfile } from './ssh-host.js';
import { redeemGatewayPairing } from './gateway-pairing.js';
import { updateGatewaySsh } from './gateway-store.js';

/** The ttl the desktop mints for the ssh-bootstrapped pairing ticket — long
 *  enough for the ssh round trip + the local iroh redemption, short enough
 *  a leaked stdout log doesn't stay exploitable. */
const SSH_PAIR_TTL_MINUTES = 15;

export type SshVaultSelection =
  | { kind: 'existing'; vaultId: string }
  | { kind: 'create'; name?: string };

export interface SshConnectInput {
  destination: string;
  dataDir?: string;
  remoteCli?: string;
  label?: string;
  /** Explicit consent for durable replica, outbox, and media state. */
  rememberDevice?: boolean;
  vault: SshVaultSelection;
}

export type SshConnectResult =
  | { ok: true; gatewayId: string; vaultId: string; vaultName: string }
  | { ok: false; error: string; message: string };

/**
 * Mint a pairing ticket for `vaultId` over ssh and redeem it locally,
 * persisting the `ssh` block onto the resulting profile. Shared by
 * {@link sshConnectGateway} (fresh connect, possibly after creating the
 * vault) and the ssh-routed `VAULTS_CREATE` (ipc.ts) — "enroll THIS device
 * into a vault just created on an already-known ssh-capable gateway".
 */
export async function sshEnrollIntoVault(
  profile: SshHostProfile,
  vaultId: string,
  label: string | undefined,
  rememberDevice = false,
): Promise<SshConnectResult> {
  const paired = await sshPair(profile, vaultId, SSH_PAIR_TTL_MINUTES);
  if (!paired.ok) return { ok: false, error: paired.error, message: paired.message };

  const redeemed = await redeemGatewayPairing({
    ticket: paired.value.ticket,
    label,
    rememberDevice,
  });
  if (!redeemed.ok) return { ok: false, error: redeemed.error, message: redeemed.message };

  // Best-effort: the pairing itself already succeeded (device is enrolled,
  // active gateway+vault are set) — a failure persisting the ssh block just
  // means the profile won't offer ssh-routed admin acts until re-tested,
  // not that the connect failed.
  try {
    await updateGatewaySsh(redeemed.gatewayId, {
      destination: profile.destination,
      ...(profile.dataDir ? { dataDir: profile.dataDir } : {}),
      ...(profile.remoteCli ? { remoteCli: profile.remoteCli } : {}),
    });
  } catch {
    // swallow — see comment above.
  }

  return {
    ok: true,
    gatewayId: redeemed.gatewayId,
    vaultId: redeemed.vaultId,
    vaultName: redeemed.vaultName,
  };
}

export async function sshConnectGateway(input: SshConnectInput): Promise<SshConnectResult> {
  const profile: SshHostProfile = {
    destination: input.destination,
    ...(input.dataDir ? { dataDir: input.dataDir } : {}),
    ...(input.remoteCli ? { remoteCli: input.remoteCli } : {}),
  };
  try {
    let vaultId: string;
    if (input.vault.kind === 'create') {
      const created = await sshVaultCreate(profile, input.vault.name);
      if (!created.ok) return { ok: false, error: created.error, message: created.message };
      vaultId = created.value.vaultId;
    } else {
      vaultId = input.vault.vaultId;
    }
    return await sshEnrollIntoVault(profile, vaultId, input.label, input.rememberDevice === true);
  } catch (err) {
    return {
      ok: false,
      error: 'unexpected_error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
