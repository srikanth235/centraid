/*
 * Phone-side peer of the zero-vault founding ceremony (issue #555).
 *
 * The SSH-minted ticket is held only in this in-memory session. Its `gw`
 * EndpointTicket is a refreshable dial hint; `t` + `s` are one-time
 * capabilities and are never written to Store or secure storage. Durable
 * gateway identity comes from `/centraid/_gateway/info`.
 */

import { Platform } from 'react-native';

import {
  generateSecretKey,
  isTunnelAvailable,
  startTunnel,
  stopTunnel,
} from '../../modules/centraid-tunnel';
import { hydratePhoneLink } from './phone-link';
import { parsePairingInput } from './phone-link-parse';
import { getSecure, setSecure } from './secure-storage';
import { LINK_SECRET_KEY, addSpace } from './spaces';

const INFO_PATH = '/centraid/_gateway/info';
const INITIALIZE_PATH = '/centraid/_vault/vaults:initialize';
const VERIFY_PATH = '/centraid/_vault/vaults:initialize/verify';
const RESTORE_PATH = '/centraid/_vault/vaults:restore';

export interface MobileFoundingSession {
  /** Kept in memory until initialize/restore consumes it. */
  foundingTicket: string;
  /** Refreshable EndpointTicket used only to dial. */
  endpointHint: string;
  /** Authoritative durable EndpointId read from the running gateway. */
  gatewayId: string;
  baseUrl: string;
}

export interface MobileInitializeResult {
  vault: { vaultId: string; name: string };
  enrollment: { enrollmentId: string };
  kit: unknown;
  fingerprint: string;
  recoveryScope: string;
}

export interface MobileRestoreResult {
  ok: true;
  reports: Array<{ vaultId: string }>;
  enrollments: Array<{ enrollmentId: string; vaultId: string }>;
}

async function json<T>(baseUrl: string, path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? (JSON.parse(text) as unknown) : {};
  } catch {
    throw new Error(`Gateway returned non-JSON for ${path}.`);
  }
  if (!response.ok) {
    const message =
      typeof body === 'object' &&
      body !== null &&
      'message' in body &&
      typeof body.message === 'string'
        ? body.message
        : `Gateway returned HTTP ${response.status}.`;
    throw new Error(message);
  }
  return body as T;
}

function post<T>(session: MobileFoundingSession, path: string, body: unknown): Promise<T> {
  return json<T>(session.baseUrl, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Validate the scanned SSH ticket and open the authenticated iroh tunnel. No
 * durable connection row is created until a ceremony completes.
 */
export async function prepareMobileFounding(rawTicket: string): Promise<MobileFoundingSession> {
  const parsed = parsePairingInput(rawTicket);
  if (!parsed || parsed.kind !== 'centraid-gw-found') {
    throw new Error('Scan a founding ticket from `centraid-gateway init-ticket`.');
  }
  if (parsed.exp <= Date.now()) {
    throw new Error('This founding ticket expired. Mint a new one over SSH.');
  }
  if (!isTunnelAvailable()) {
    throw new Error('Vault founding requires a native Centraid mobile build.');
  }
  await hydratePhoneLink();
  let secretKeyB64 = getSecure(LINK_SECRET_KEY, '');
  if (!secretKeyB64) {
    secretKeyB64 = await generateSecretKey();
    await setSecure(LINK_SECRET_KEY, secretKeyB64);
  }
  await stopTunnel().catch(() => undefined);
  const { port } = await startTunnel({ ticket: parsed.gw, secretKeyB64 });
  const baseUrl = `http://127.0.0.1:${port}`;
  const info = await json<{ status?: unknown; endpointId?: unknown }>(baseUrl, INFO_PATH, {
    method: 'GET',
  });
  if (info.status !== 'uninitialized' || typeof info.endpointId !== 'string') {
    await stopTunnel().catch(() => undefined);
    throw new Error('This gateway is already founded. Use its ordinary pairing code.');
  }
  return {
    foundingTicket: rawTicket.trim(),
    endpointHint: parsed.gw,
    gatewayId: info.endpointId,
    baseUrl,
  };
}

export function initializeMobileVault(
  session: MobileFoundingSession,
  input: { name: string; password: string; deviceName: string },
): Promise<MobileInitializeResult> {
  return post<MobileInitializeResult>(session, INITIALIZE_PATH, {
    ticket: session.foundingTicket,
    name: input.name,
    password: input.password,
    deviceName: input.deviceName,
    platform: Platform.OS,
  });
}

export function verifyMobileFoundingKit(
  session: MobileFoundingSession,
  input: { kit: unknown; password: string; lossConsent: true },
): Promise<{ ok: true; vaultId: string; fingerprint: string }> {
  return post(session, VERIFY_PATH, input);
}

export function restoreMobileVaults(
  session: MobileFoundingSession,
  input: {
    kit: unknown;
    password: string;
    apiKey: string;
    deviceName: string;
  },
): Promise<MobileRestoreResult> {
  return post<MobileRestoreResult>(session, RESTORE_PATH, {
    ticket: session.foundingTicket,
    kit: input.kit,
    password: input.password,
    apiKey: input.apiKey,
    deviceName: input.deviceName,
    platform: Platform.OS,
  });
}

/** Persist only EndpointId + endpoint hint after the server ceremony succeeds. */
export async function rememberInitializedVault(
  session: MobileFoundingSession,
  initialized: MobileInitializeResult,
): Promise<void> {
  await addSpace({
    gatewayId: session.gatewayId,
    endpointHint: session.endpointHint,
    desktopName: 'Gateway',
    deviceId: initialized.enrollment.enrollmentId,
    vaultId: initialized.vault.vaultId,
    vaultName: initialized.vault.name,
  });
}

export async function rememberRestoredVaults(
  session: MobileFoundingSession,
  restored: MobileRestoreResult,
): Promise<void> {
  const rememberNext = async (index: number): Promise<void> => {
    const report = restored.reports[index];
    if (!report) return;
    const enrollment = restored.enrollments.find((row) => row.vaultId === report.vaultId);
    await addSpace({
      gatewayId: session.gatewayId,
      endpointHint: session.endpointHint,
      desktopName: 'Gateway',
      deviceId: enrollment?.enrollmentId ?? session.gatewayId,
      vaultId: report.vaultId,
      vaultName: restored.reports.length === 1 ? 'Restored vault' : `Restored vault ${index + 1}`,
    });
    return rememberNext(index + 1);
  };
  return rememberNext(0);
}
