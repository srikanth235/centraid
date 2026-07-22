/*
 * Pure pairing-ticket parsers for mobile (no React Native imports).
 *
 * Desktop QR: JSON `{v:1, kind:'centraid-pair', ticket, code}`
 * Headless VPS: base64url JSON `{v:1, kind:'centraid-gw-pair', gw, t, s, …}`
 * from `centraid-gateway pair` / `pair --qr`.
 */

import { base64ToBytes } from './upload/bytes';

/** Desktop "Connect phone" QR payload (issue #263). */
export type DesktopPairPayload = {
  kind: 'centraid-pair';
  ticket: string;
  code: string;
};

/** Headless gateway ticket from `centraid-gateway pair` (issue #289 / #376). */
export type GatewayPairPayload = {
  kind: 'centraid-gw-pair';
  /** Gateway iroh EndpointTicket (identity + relay hint). */
  gw: string;
  t: string;
  s: string;
  vaultName: string;
  exp: number;
};

export type PairingInput = DesktopPairPayload | GatewayPairPayload;

/**
 * Parse the desktop's pairing QR payload. Local mirror of
 * `parsePairQrPayload` in packages/tunnel/src/protocol.ts.
 */
export function parsePairQr(raw: string): { ticket: string; code: string } | undefined {
  const parsed = parsePairingInput(raw);
  if (!parsed || parsed.kind !== 'centraid-pair') return undefined;
  return { ticket: parsed.ticket, code: parsed.code };
}

/**
 * Accept either a desktop QR JSON string or a one-line `centraid-gw-pair`
 * base64url token (scan or paste). Whitespace-tolerant.
 */
export function parsePairingInput(raw: string): PairingInput | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Desktop QR is plain JSON.
  try {
    const obj = JSON.parse(trimmed) as Partial<{
      v: number;
      kind: string;
      ticket: string;
      code: string;
    }>;
    if (obj.v === 1 && obj.kind === 'centraid-pair') {
      if (typeof obj.ticket !== 'string' || typeof obj.code !== 'string') return undefined;
      return { kind: 'centraid-pair', ticket: obj.ticket, code: obj.code };
    }
  } catch {
    /* not JSON — try gw-pair token */
  }

  // One-line gateway ticket (base64url of JSON).
  try {
    const json = utf8FromBase64Url(trimmed);
    const obj = JSON.parse(json) as Partial<{
      v: number;
      kind: string;
      gw: string;
      t: string;
      s: string;
      vaultName: string;
      exp: number;
    }>;
    if (obj.v !== 1 || obj.kind !== 'centraid-gw-pair') return undefined;
    if (typeof obj.gw !== 'string' || obj.gw.length === 0) return undefined;
    if (typeof obj.t !== 'string' || obj.t.length === 0) return undefined;
    if (typeof obj.s !== 'string' || obj.s.length === 0) return undefined;
    if (typeof obj.vaultName !== 'string') return undefined;
    if (typeof obj.exp !== 'number' || !Number.isFinite(obj.exp)) return undefined;
    return {
      kind: 'centraid-gw-pair',
      gw: obj.gw,
      t: obj.t,
      s: obj.s,
      vaultName: obj.vaultName,
      exp: obj.exp,
    };
  } catch {
    return undefined;
  }
}

function utf8FromBase64Url(raw: string): string {
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = base64ToBytes(b64);
  return new TextDecoder().decode(bytes);
}
