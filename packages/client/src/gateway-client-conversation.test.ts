import { beforeAll, beforeEach, expect, test, vi } from 'vitest';

let streamTurn: typeof import('./gateway-client-conversation.js').streamTurn;

beforeAll(async () => {
  (window as unknown as { CentraidApi: unknown }).CentraidApi = {
    getGatewayAuth: async () => ({
      baseUrl: 'https://gateway.test',
      token: 'tok',
      vaultId: 'vault-1',
    }),
    onGatewayChanged: () => () => undefined,
    onVaultChanged: () => () => undefined,
  };
  ({ streamTurn } = await import('./gateway-client-conversation.js'));
});

beforeEach(() => vi.restoreAllMocks());

/** A minimal SSE Response body that ends cleanly (`event: end`). */
function sseResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode('event: final\ndata: {"type":"final","text":"ok"}\n\n'));
      controller.enqueue(enc.encode('event: end\ndata: {}\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('streamTurn threads idempotencyKey into the POST body (#420)', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
  const events: Array<{ type: string }> = [];
  const result = await streamTurn(
    'demo',
    { conversationId: 'c1', message: 'hi', idempotencyKey: 'key-abc' },
    (e) => events.push(e as { type: string }),
    new AbortController().signal,
  );
  expect(result.ended).toBe(true);
  expect(events.map((e) => e.type)).toContain('final');
  const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
  expect(body.idempotencyKey).toBe('key-abc');
});

test('streamTurn auto-retries a 429 honoring Retry-After, then succeeds (#420)', async () => {
  const busy = new Response(JSON.stringify({ error: 'turn_busy' }), {
    status: 429,
    headers: { 'retry-after': '0.02' },
  });
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(busy)
    .mockResolvedValueOnce(sseResponse());
  const events: Array<{ type: string }> = [];
  const result = await streamTurn(
    'demo',
    { conversationId: 'c1', message: 'hi', idempotencyKey: 'key-1' },
    (e) => events.push(e as { type: string }),
    new AbortController().signal,
  );
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  expect(result.ended).toBe(true);
  // The retry carried the SAME idempotency key, so it can only ever replay.
  const b1 = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
  const b2 = JSON.parse((fetchSpy.mock.calls[1]![1] as RequestInit).body as string);
  expect(b1.idempotencyKey).toBe('key-1');
  expect(b2.idempotencyKey).toBe('key-1');
});
