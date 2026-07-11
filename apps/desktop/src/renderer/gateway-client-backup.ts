/*
 * Renderer-side client for the offsite backup engine's HTTP surface
 * (`GET /centraid/_gateway/backup`, `POST /centraid/_gateway/backup/run`,
 * `POST /centraid/_gateway/backup/kit-confirmed` —
 * `packages/gateway/src/routes/backup-routes.ts`, issue #351's last
 * workstream; wave 4 adds the recovery-kit confirmation gate). Backs the
 * Gateway page's Backup card.
 */

import { auth, authHeaders, doFetch, readJson } from './gateway-client-core.js';

/** One vault's backup state, as `_gateway/backup` reports it. */
export interface GatewayBackupVaultDTO {
  vaultId: string;
  name?: string;
  lastBackupAt?: string;
  lastVerifyAt?: string;
  lastError?: string;
  running?: boolean;
}

/**
 * Recovery-kit confirmation gate (issue #351 wave 4 / #367) — deliberately
 * generic, not backup-card-specific: issue #367 reuses this same
 * `{confirmedAt}` shape to gate the S3-storage enable flow.
 */
export interface GatewayRecoveryKitStatusDTO {
  /** Epoch SECONDS the operator last confirmed, or `null` if never. */
  confirmedAt: number | null;
}

export interface GatewayBackupStatusDTO {
  configured: boolean;
  vaults: GatewayBackupVaultDTO[];
  recoveryKit: GatewayRecoveryKitStatusDTO;
}

/** Backup status for every mounted vault — `{configured: false, vaults: []}`
 *  when the gateway has no `backup` block. */
export async function getGatewayBackupStatus(): Promise<GatewayBackupStatusDTO> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_gateway/backup', {
    method: 'GET',
    headers: authHeaders(token),
  });
  return readJson<GatewayBackupStatusDTO>(res, 'gateway backup status');
}

export interface GatewayBackupRunResultDTO {
  accepted: boolean;
  /** A run was already in flight — this POST didn't enqueue a second one. */
  alreadyRunning?: boolean;
}

/**
 * Trigger an immediate backup of every mounted vault (the Gateway page's
 * "Back up now"). Resolves as soon as the gateway ACCEPTS the request
 * (HTTP 202) — the run itself happens in the background; poll
 * `getGatewayBackupStatus` to see it land. Rejects with a
 * `GatewayClientError` (code `'conflict'`) if backup isn't configured.
 */
export async function runGatewayBackupNow(): Promise<GatewayBackupRunResultDTO> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_gateway/backup/run', {
    method: 'POST',
    headers: authHeaders(token),
  });
  return readJson<GatewayBackupRunResultDTO>(res, 'run gateway backup');
}

/**
 * Confirm the operator has exported and safely stored the recovery kit
 * (the Gateway page's "I've saved my recovery kit" button). Unlike
 * `GatewayRecoveryKitStatusDTO.confirmedAt` (which can be `null` — never
 * confirmed), this POST always stamps the current clock, so the response's
 * `confirmedAt` is always a number. Rejects with a `GatewayClientError`
 * (code `'conflict'`) if backup isn't configured — there's no keyring to
 * have exported a kit from.
 */
export async function confirmGatewayRecoveryKit(): Promise<{ confirmedAt: number }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_gateway/backup/kit-confirmed', {
    method: 'POST',
    headers: authHeaders(token),
  });
  return readJson<{ ok: true; confirmedAt: number }>(res, 'confirm gateway recovery kit');
}
