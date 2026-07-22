import type { CentraidConnectivityReport } from '../../../packages/client/src/centraid-api.js';
import {
  handshakeGateway,
  type HandshakeResult,
} from '../../../packages/client/src/version-handshake.js';

function stagesFromHandshake(handshake: HandshakeResult): CentraidConnectivityReport {
  if (handshake.ok) {
    return {
      ok: true,
      stages: [
        { id: 'reach', label: 'Reach gateway', status: 'pass' },
        { id: 'identify', label: 'Identify gateway', status: 'pass' },
        { id: 'auth', label: 'Authenticate', status: 'pass' },
      ],
    };
  }

  const statusMatch = /^HTTP (\d+)$/.exec(handshake.detail);
  const status = statusMatch?.[1] !== undefined ? Number(statusMatch[1]) : undefined;

  if (status === 401 || status === 403) {
    return {
      ok: false,
      error: 'auth_failed',
      stages: [
        { id: 'reach', label: 'Reach gateway', status: 'pass' },
        {
          id: 'auth',
          label: 'Authenticate',
          status: 'fail',
          detail: 'The gateway rejected the credential.',
        },
      ],
    };
  }

  if (handshake.reason === 'protocol_mismatch' || handshake.reason === 'malformed') {
    return {
      ok: false,
      error: handshake.reason,
      stages: [
        { id: 'reach', label: 'Reach gateway', status: 'pass' },
        {
          id: 'identify',
          label: 'Identify gateway',
          status: 'fail',
          detail: handshake.detail,
        },
        { id: 'auth', label: 'Authenticate', status: 'skip' },
      ],
    };
  }

  return {
    ok: false,
    error: 'unreachable',
    stages: [
      {
        id: 'reach',
        label: 'Reach gateway',
        status: 'fail',
        detail: handshake.detail,
      },
      { id: 'identify', label: 'Identify gateway', status: 'skip' },
      { id: 'auth', label: 'Authenticate', status: 'skip' },
    ],
  };
}

export async function testUrl(url: string, token?: string): Promise<CentraidConnectivityReport> {
  const handshake = await handshakeGateway(url, token);
  return stagesFromHandshake(handshake);
}
