import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RecoverEvent,
  discoverRecovery as discoverFn,
  getRecoverStatus as statusFn,
  startRecovery as startFn,
  streamRecoverEvents as streamFn,
  validateRecoveryKit as validateFn,
} from './gateway-client-recover.js';

let validateRecoveryKit: typeof validateFn;
let discoverRecovery: typeof discoverFn;
let startRecovery: typeof startFn;
let getRecoverStatus: typeof statusFn;
let streamRecoverEvents: typeof streamFn;

beforeAll(async () => {
  (window as unknown as { CentraidApi: unknown }).CentraidApi = {
    // No vaultId — recovery runs pre-vault, so doFetch stamps no vault header.
    getGatewayAuth: async () => ({ baseUrl: 'https://gateway.test', token: 'admin-tok' }),
    onGatewayChanged: () => () => undefined,
    onVaultChanged: () => () => undefined,
  };
  const mod = await import('./gateway-client-recover.js');
  ({ validateRecoveryKit, discoverRecovery, startRecovery, getRecoverStatus, streamRecoverEvents } =
    mod);
});

beforeEach(() => vi.restoreAllMocks());

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('validateRecoveryKit', () => {
  it('POSTs the kit document itself and returns the sanitized target summary', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({
        ok: true,
        createdAt: '2026-07-17T00:00:00.000Z',
        targets: [{ label: 'home', vaultId: 'v1', providerHost: 'storage.example.com' }],
      }),
    );
    const result = await validateRecoveryKit({ kind: 'centraid-recovery-kit', version: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.targets[0]).toEqual({
        label: 'home',
        vaultId: 'v1',
        providerHost: 'storage.example.com',
      });
    }
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/centraid/_gateway/recover/kit');
    // The body is the kit document itself, not wrapped in {kit}.
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      kind: 'centraid-recovery-kit',
      version: 1,
    });
  });

  it('surfaces the gateway invalid_kit message on a 400', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ error: 'invalid_kit', message: 'not a centraid recovery kit' }, 400),
    );
    const result = await validateRecoveryKit({});
    expect(result).toEqual({ ok: false, message: 'not a centraid recovery kit' });
  });
});

describe('discoverRecovery', () => {
  it('maps the found-your-vault facts', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({
        found: true,
        label: 'home',
        vaultId: 'v1',
        providerHost: 'storage.example.com',
        sizeBytes: 4_500_000_000,
        asOfMs: 1_700_000_000_000,
        restoreCostClass: 'metered-egress',
        lazyAvailable: true,
      }),
    );
    const d = await discoverRecovery({ kit: {}, apiKey: 'k' });
    expect(d.found).toBe(true);
    if (d.found) {
      expect(d.sizeBytes).toBe(4_500_000_000);
      expect(d.restoreCostClass).toBe('metered-egress');
      expect(d.providerHost).toBe('storage.example.com');
    }
  });

  it('reads a provider 401 as a wrong key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ error: 'unauthorized', message: 'bad key' }, 401),
    );
    const d = await discoverRecovery({ kit: {}, apiKey: 'nope' });
    expect(d).toMatchObject({ found: false, reason: 'wrong_key' });
  });

  it('reads a 404 as no snapshot and a 409 as incompatible', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ error: 'no_snapshot' }, 404));
    expect(await discoverRecovery({ kit: {}, apiKey: 'k' })).toMatchObject({
      found: false,
      reason: 'no_snapshot',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      json({ error: 'incompatible', message: 'update the gateway' }, 409),
    );
    expect(await discoverRecovery({ kit: {}, apiKey: 'k' })).toMatchObject({
      found: false,
      reason: 'incompatible',
    });
  });
});

describe('startRecovery', () => {
  it('returns the jobId on 202', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ jobId: 'job-1' }, 202));
    expect(await startRecovery({ kit: {}, apiKey: 'k' })).toEqual({
      started: true,
      jobId: 'job-1',
    });
  });

  it('threads confirmed:true only when passed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ jobId: 'job-2' }, 202));
    await startRecovery({ kit: {}, apiKey: 'k', confirmed: true });
    expect(JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string).confirmed).toBe(
      true,
    );
  });

  it('returns confirm_required with the estimate on a metered 409', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(
        {
          error: 'confirm_required',
          message: 'metered',
          estimate: {
            sizeBytes: 9_000_000_000,
            asOfMs: 1_700_000_000_000,
            restoreCostClass: 'metered-egress',
            lazyAvailable: true,
          },
        },
        409,
      ),
    );
    const r = await startRecovery({ kit: {}, apiKey: 'k' });
    expect(r.started).toBe(false);
    if (!r.started && r.reason === 'confirm_required') {
      expect(r.estimate.sizeBytes).toBe(9_000_000_000);
      expect(r.estimate.restoreCostClass).toBe('metered-egress');
    }
  });

  it('maps not_fresh and recover_in_progress', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ error: 'not_fresh' }, 409));
    expect(await startRecovery({ kit: {}, apiKey: 'k' })).toMatchObject({
      started: false,
      reason: 'not_fresh',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      json({ error: 'recover_in_progress' }, 409),
    );
    expect(await startRecovery({ kit: {}, apiKey: 'k' })).toMatchObject({
      started: false,
      reason: 'in_progress',
    });
  });
});

describe('getRecoverStatus', () => {
  it('folds fresh + the job record', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ fresh: true, job: { jobId: 'j', state: 'running', phase: 'fetching' } }),
    );
    const st = await getRecoverStatus();
    expect(st.fresh).toBe(true);
    expect(st.job?.state).toBe('running');
  });
});

describe('streamRecoverEvents', () => {
  function sse(frames: string[]): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const f of frames) controller.enqueue(enc.encode(f));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }

  it('parses phase, report, and end frames in order', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sse([
        'event: phase\ndata: {"phase":"fetching"}\n\n',
        'event: phase\ndata: {"phase":"warming"}\n\n',
        'event: report\ndata: {"vaultId":"v1","recoveredAsOf":123,"quarantine":["outbox"]}\n\n',
        'event: end\ndata: {"state":"done"}\n\n',
      ]),
    );
    const events: RecoverEvent[] = [];
    await streamRecoverEvents('job-1', (ev) => events.push(ev), new AbortController().signal);
    expect(events.map((e) => e.kind)).toEqual(['phase', 'phase', 'report', 'end']);
    const report = events.find((e) => e.kind === 'report');
    expect(report && report.kind === 'report' ? report.report.recoveredAsOf : 0).toBe(123);
    const end = events.at(-1);
    expect(end && end.kind === 'end' ? end.state : '').toBe('done');
  });
});
