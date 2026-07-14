import type { CentraidConnectivityReport } from '../../../packages/client/src/centraid-api.js';

export async function testUrl(url: string, token?: string): Promise<CentraidConnectivityReport> {
  try {
    const response = await fetch(
      new URL('/centraid/_gateway/info', `${url.replace(/\/+$/, '')}/`),
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
    );
    if (response.status === 401 || response.status === 403) {
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
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return {
      ok: true,
      stages: [
        { id: 'reach', label: 'Reach gateway', status: 'pass' },
        { id: 'identify', label: 'Identify gateway', status: 'pass' },
        { id: 'auth', label: 'Authenticate', status: 'pass' },
      ],
    };
  } catch (error) {
    return {
      ok: false,
      error: 'unreachable',
      stages: [
        {
          id: 'reach',
          label: 'Reach gateway',
          status: 'fail',
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}
