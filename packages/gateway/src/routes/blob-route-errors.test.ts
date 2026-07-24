import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  VaultBlobAuthorizationError,
  VaultBlobBackpressureError,
  VaultBlobHashMismatchError,
  VaultBlobRemoteUnavailableError,
  VaultBlobSessionError,
  VaultDiskFullError,
} from '@centraid/vault';
import { sendBlobRouteError } from './blob-route-errors.js';

interface MockRes {
  headersSent: boolean;
  destroyed: boolean;
  statusCode?: number;
  body?: string;
  headers: Record<string, string>;
  setHeader: (name: string, value: string | number | readonly string[]) => MockRes;
  writeHead: (status: number, headers?: Record<string, string>) => MockRes;
  end: (chunk?: unknown) => MockRes;
  destroy: ReturnType<typeof vi.fn>;
}

function mockRes(over: Partial<MockRes> = {}): MockRes {
  const res: MockRes = {
    headersSent: false,
    destroyed: false,
    headers: {},
    setHeader(name: string, value: string | number | readonly string[]): MockRes {
      res.headers[name.toLowerCase()] = String(value);
      return res;
    },
    writeHead(status: number, headers?: Record<string, string>): MockRes {
      res.statusCode = status;
      res.headersSent = true;
      if (headers) Object.assign(res.headers, headers);
      return res;
    },
    end(chunk?: unknown): MockRes {
      res.headersSent = true;
      if (chunk !== undefined && chunk !== null) {
        res.body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      }
      return res;
    },
    destroy: vi.fn(function destroy(this: MockRes) {
      this.destroyed = true;
      return this;
    }),
    ...over,
  };
  return res;
}

function asServerRes(res: MockRes): ServerResponse {
  return res as unknown as ServerResponse;
}

describe('sendBlobRouteError', () => {
  it('destroys the response when headers were already sent', () => {
    const res = mockRes({ headersSent: true, destroyed: false });
    expect(sendBlobRouteError(asServerRes(res), new Error('late'))).toBe(true);
    expect(res.destroy).toHaveBeenCalled();
  });

  it('is a no-op when the socket is already destroyed', () => {
    const res = mockRes({ headersSent: true, destroyed: true });
    expect(sendBlobRouteError(asServerRes(res), new Error('gone'))).toBe(true);
    expect(res.destroy).not.toHaveBeenCalled();
  });

  it('maps each typed vault blob error to its HTTP status', () => {
    const cases: Array<{ err: Error; status: number; error?: string }> = [
      {
        err: new VaultBlobBackpressureError('write', 'full', {
          needBytes: 1,
          availableBytes: 0,
          freeBytes: 0,
          reservedHeadroomBytes: 0,
        }),
        status: 429,
        error: 'blob_capacity_exceeded',
      },
      {
        err: new VaultBlobHashMismatchError('aa', 'bb'),
        status: 422,
        error: 'blob_hash_mismatch',
      },
      {
        err: new VaultBlobSessionError('bad offset', 12),
        status: 409,
        error: 'blob_session_conflict',
      },
      {
        err: new VaultBlobSessionError('conflict only'),
        status: 409,
        error: 'blob_session_conflict',
      },
      {
        err: new VaultBlobAuthorizationError('nope'),
        status: 403,
        error: 'blob_device_forbidden',
      },
      {
        err: new VaultBlobRemoteUnavailableError('down'),
        status: 503,
        error: 'blob_remote_unavailable',
      },
      {
        err: new VaultDiskFullError('disk', 'no space'),
        status: 507,
      },
      {
        err: new Error('generic'),
        status: 400,
      },
    ];

    for (const c of cases) {
      const res = mockRes();
      expect(sendBlobRouteError(asServerRes(res), c.err)).toBe(true);
      expect(res.statusCode).toBe(c.status);
      const body = JSON.parse(res.body ?? '{}') as { error?: string; expectedOffset?: number };
      if (c.error) expect(body.error).toBe(c.error);
      if (c.err instanceof VaultBlobSessionError && c.err.expectedOffset !== undefined) {
        expect(body.expectedOffset).toBe(12);
      }
    }
  });

  it('stringifies non-Error failures as 400', () => {
    const res = mockRes();
    sendBlobRouteError(asServerRes(res), 'raw');
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body ?? '{}')).toEqual({ error: 'raw' });
  });
});
