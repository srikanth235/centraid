/*
 * Transport tiers for a gateway profile (issue #289 phase 3).
 *
 * A gateway is reached three ways, and the profile names which:
 *
 *   - `local`  — the in-process embedded gateway (loopback, per-launch token).
 *   - `iroh`   — a remote gateway addressed by its EndpointId over the same
 *                QUIC tunnel the phone speaks; no URL, no TLS, no exposed port.
 *   - `direct` — a remote gateway at an https URL + token (Tailscale / Caddy /
 *                Cloudflare Tunnel users who front their own transport).
 *
 * `gateway-client-core` stays transport-blind: every tier resolves to a base
 * URL + token the HTTP client uses unchanged (an iroh profile resolves to a
 * loopback proxy URL — see `iroh-dialer.ts`). This module owns only the pure
 * classification + the plain-HTTP guardrail; it imports no electron.
 */

export type GatewayTransport = 'local' | 'iroh' | 'direct';

/** The transport-relevant shape of a gateway profile. */
export interface TransportProfileFields {
  kind: 'local' | 'remote';
  /** Explicit tier. Absent on pre-#289 profiles — derived from kind + url. */
  transport?: GatewayTransport;
  /** Remote https/http URL (direct transport). */
  url?: string;
  /** Remote iroh EndpointId (iroh transport). */
  endpointId?: string;
}

/**
 * Resolve a profile's transport tier. Explicit `transport` wins; otherwise
 * derive it (back-compat with pre-#289 profiles): local kind → `local`, an
 * EndpointId → `iroh`, else `direct`.
 */
export function resolveTransport(profile: TransportProfileFields): GatewayTransport {
  if (profile.transport) return profile.transport;
  if (profile.kind === 'local') return 'local';
  if (profile.endpointId) return 'iroh';
  return 'direct';
}

/** A private-use host that plain HTTP is acceptable for (loopback / RFC1918 / LAN). */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '::') return true;
  // IPv4 dotted quad.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }
  // IPv6 unique-local (fc00::/7) + link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  // `.local` mDNS names are LAN.
  if (h.endsWith('.local')) return true;
  return false;
}

export class TransportGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportGuardError';
  }
}

/**
 * Guardrail (issue #289 decision 6): refuse plain `http://` to a public host.
 * A cleartext bearer to the open internet is the exact failure the iroh
 * transport exists to avoid; loopback / RFC1918 / LAN stay allowed (a
 * `ssh -L` tunnel or a trusted LAN is the intended plain-HTTP path). `https`
 * is always allowed; a malformed URL is rejected.
 */
export function assertDirectUrlAllowed(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new TransportGuardError(`Gateway URL "${rawUrl}" is not a valid URL.`);
  }
  if (url.protocol === 'https:') return;
  if (url.protocol !== 'http:') {
    throw new TransportGuardError(`Gateway URL must be http or https, not "${url.protocol}".`);
  }
  if (!isPrivateHost(url.hostname)) {
    throw new TransportGuardError(
      `Refusing plain http:// to public host "${url.hostname}" — the bearer ` +
        'token would travel in cleartext. Use https, an iroh endpoint, or an ' +
        'ssh -L tunnel to a loopback-bound gateway.',
    );
  }
}
