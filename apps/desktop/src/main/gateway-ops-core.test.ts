import { describe, expect, it } from 'vitest';
import {
  diagnosticsFileName,
  exportGatewayDiagnostics,
  fetchDiagnosticsText,
  type ExportDiagnosticsDeps,
} from './gateway-ops-core.js';

describe('diagnosticsFileName', () => {
  it('formats the local calendar date, zero-padded', () => {
    expect(diagnosticsFileName(new Date(2026, 0, 5))).toBe('centraid-diagnostics-2026-01-05.json');
    expect(diagnosticsFileName(new Date(2026, 10, 23))).toBe(
      'centraid-diagnostics-2026-11-23.json',
    );
  });
});

describe('fetchDiagnosticsText', () => {
  it('pretty-prints a successful JSON response', async () => {
    const result = await fetchDiagnosticsText(
      'http://127.0.0.1:1',
      'tok',
      async () => new Response(JSON.stringify({ status: 'ok', components: [] }), { status: 200 }),
    );
    expect(result).toEqual({
      ok: true,
      text: JSON.stringify({ status: 'ok', components: [] }, null, 2),
    });
  });

  it('surfaces a non-2xx as an HTTP error', async () => {
    const result = await fetchDiagnosticsText(
      'http://gw',
      undefined,
      async () => new Response('', { status: 503 }),
    );
    expect(result).toEqual({ ok: false, error: 'HTTP 503' });
  });

  it('surfaces a network failure', async () => {
    const result = await fetchDiagnosticsText('http://gw', undefined, async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(result).toEqual({ ok: false, error: 'ECONNREFUSED' });
  });

  it('surfaces a malformed (non-JSON) response', async () => {
    const result = await fetchDiagnosticsText(
      'http://gw',
      undefined,
      async () => new Response('not json', { status: 200 }),
    );
    expect(result).toEqual({ ok: false, error: 'diagnostics response was not JSON' });
  });
});

function makeDeps(overrides: Partial<ExportDiagnosticsDeps> = {}): ExportDiagnosticsDeps {
  return {
    loadSettings: async () => ({ gatewayUrl: 'http://127.0.0.1:4000', gatewayToken: 'tok' }),
    fetchImpl: async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    showSaveDialog: async (defaultPath) => ({ canceled: false, filePath: `/tmp/${defaultPath}` }),
    writeFile: async () => undefined,
    now: () => new Date(2026, 6, 11),
    ...overrides,
  };
}

describe('exportGatewayDiagnostics', () => {
  it('happy path: fetches, saves, and returns the written path', async () => {
    const writes: Array<{ path: string; data: string }> = [];
    const result = await exportGatewayDiagnostics(
      makeDeps({ writeFile: async (path, data) => void writes.push({ path, data }) }),
    );
    expect(result).toEqual({ ok: true, path: '/tmp/centraid-diagnostics-2026-07-11.json' });
    expect(writes).toEqual([
      {
        path: '/tmp/centraid-diagnostics-2026-07-11.json',
        data: JSON.stringify({ status: 'ok' }, null, 2),
      },
    ]);
  });

  it('canceled dialog: no write, ok:false with canceled:true', async () => {
    const writes: unknown[] = [];
    const result = await exportGatewayDiagnostics(
      makeDeps({
        showSaveDialog: async () => ({ canceled: true }),
        writeFile: async () => void writes.push(1),
      }),
    );
    expect(result).toEqual({ ok: false, canceled: true });
    expect(writes).toEqual([]);
  });

  it('no active gateway URL: refuses before ever fetching', async () => {
    let fetchCalled = false;
    const result = await exportGatewayDiagnostics(
      makeDeps({
        loadSettings: async () => ({ gatewayUrl: '' }),
        fetchImpl: async () => {
          fetchCalled = true;
          throw new Error('should not be called');
        },
      }),
    );
    expect(result).toEqual({ ok: false, error: 'No active gateway to export diagnostics from.' });
    expect(fetchCalled).toBe(false);
  });

  it('fetch error: surfaced without opening the save dialog', async () => {
    let dialogCalled = false;
    const result = await exportGatewayDiagnostics(
      makeDeps({
        fetchImpl: async () => new Response('', { status: 500 }),
        showSaveDialog: async () => {
          dialogCalled = true;
          return { canceled: true };
        },
      }),
    );
    expect(result).toEqual({ ok: false, error: 'HTTP 500' });
    expect(dialogCalled).toBe(false);
  });

  it('write failure: surfaced as ok:false with the error message', async () => {
    const result = await exportGatewayDiagnostics(
      makeDeps({
        writeFile: async () => {
          throw new Error('EACCES: permission denied');
        },
      }),
    );
    expect(result).toEqual({ ok: false, error: 'EACCES: permission denied' });
  });
});
