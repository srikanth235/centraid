export interface PairingTicket {
  readonly endpointTicket: string;
  readonly ticketId: string;
  readonly secret: string;
  readonly vaultName?: string;
  readonly expiresAt?: number;
  readonly relayUrls?: readonly string[];
}

export function decodePairingTicket(raw: string): PairingTicket | undefined {
  try {
    const base64 = raw.trim().replaceAll('-', '+').replaceAll('_', '/');
    const decoded = JSON.parse(atob(base64)) as Record<string, unknown>;
    if (decoded['kind'] !== 'centraid-gw-pair') return undefined;
    if (typeof decoded['gw'] !== 'string') return undefined;
    if (typeof decoded['t'] !== 'string') return undefined;
    if (typeof decoded['s'] !== 'string') return undefined;
    return {
      endpointTicket: decoded['gw'],
      ticketId: decoded['t'],
      secret: decoded['s'],
      ...(typeof decoded['vaultName'] === 'string' ? { vaultName: decoded['vaultName'] } : {}),
      ...(typeof decoded['exp'] === 'number' ? { expiresAt: decoded['exp'] } : {}),
      ...(Array.isArray(decoded['relays']) && decoded['relays'].every((v) => typeof v === 'string')
        ? { relayUrls: decoded['relays'] as string[] }
        : {}),
    };
  } catch {
    return undefined;
  }
}
