/*
 * Client for the zero-vault founding plane (issue #555).
 *
 * The direct host may mint its own short-lived founding ticket; a remote
 * device supplies the one scanned from `centraid-gateway init-ticket`.
 * Both then use the same initialize/restore routes and prove their iroh
 * identity at the gateway.
 */

import { auth, authHeaders, doFetch, readJson } from './gateway-client-core.js';

export interface FoundingStatus {
  status: 'uninitialized' | 'ready';
  endpointId?: string;
  /**
   * The vault exists but its recovery kit was never verified — the ceremony
   * was interrupted between the kit download and the re-select (issue #568
   * item G). Create and restore both 409 in this state; only verify moves.
   */
  foundingPending?: boolean;
}

export interface FoundingInitializeResult {
  vault: { vaultId: string; name: string };
  kit: unknown;
  fingerprint: string;
  recoveryScope: string;
}

export interface FoundingVerifyResult {
  ok: true;
  vaultId: string;
  fingerprint: string;
}

export interface FoundingRestoreResult {
  ok: true;
  report: { vaultId: string };
  reports: Array<{ vaultId: string }>;
}

export async function getGatewayFoundingStatus(): Promise<FoundingStatus> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_gateway/info', {
    method: 'GET',
    headers: authHeaders(token),
  });
  const body = await readJson<{
    status?: unknown;
    endpointId?: unknown;
    foundingPending?: unknown;
  }>(res, 'read gateway founding status');
  return {
    status: body.status === 'uninitialized' ? 'uninitialized' : 'ready',
    ...(typeof body.endpointId === 'string' ? { endpointId: body.endpointId } : {}),
    ...(body.foundingPending === true ? { foundingPending: true } : {}),
  };
}

export async function mintGatewayFoundingTicket(): Promise<string> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_gateway/founding/ticket', {
    method: 'POST',
    headers: authHeaders(token),
  });
  const body = await readJson<{ ticket: string }>(res, 'mint gateway founding ticket');
  return body.ticket;
}

async function foundingTicket(ticket: string | undefined): Promise<string> {
  const supplied = ticket?.trim();
  return supplied || mintGatewayFoundingTicket();
}

export async function initializeGatewayVault(input: {
  ticket?: string;
  name: string;
  password: string;
  deviceName?: string;
  platform?: string;
}): Promise<FoundingInitializeResult> {
  const { baseUrl, token } = await auth();
  const ticket = await foundingTicket(input.ticket);
  const res = await doFetch(baseUrl, '/centraid/_vault/vaults:initialize', {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ ...input, ticket }),
  });
  return readJson<FoundingInitializeResult>(res, 'create gateway vault');
}

export async function verifyGatewayFoundingKit(input: {
  kit: unknown;
  password: string;
  lossConsent: true;
}): Promise<FoundingVerifyResult> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_vault/vaults:initialize/verify', {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify(input),
  });
  return readJson<FoundingVerifyResult>(res, 'verify gateway recovery kit');
}

export async function restoreGatewayVault(input: {
  ticket?: string;
  kit: unknown;
  password: string;
  apiKey: string;
  deviceName?: string;
  platform?: string;
}): Promise<FoundingRestoreResult> {
  const { baseUrl, token } = await auth();
  const ticket = await foundingTicket(input.ticket);
  const res = await doFetch(baseUrl, '/centraid/_vault/vaults:restore', {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ ...input, ticket }),
  });
  return readJson<FoundingRestoreResult>(res, 'restore gateway vault');
}
