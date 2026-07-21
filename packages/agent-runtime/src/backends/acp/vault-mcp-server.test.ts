// Coverage for the per-turn loopback MCP endpoint: routing, the bearer gate,
// the JSON-RPC dispatch surface (initialize / ping / tools/list / tools/call),
// malformed-request handling, and idempotent teardown. Driven with raw fetch
// against the real listener rather than through a spawned agent.

import { afterEach, expect, test } from 'vitest';
import {
  startVaultMcpServer,
  type VaultMcpHandle,
  type VaultMcpHooks,
} from './vault-mcp-server.ts';
import { vaultToolContext } from './test-fixtures.ts';

const openHandles: VaultMcpHandle[] = [];
afterEach(async () => {
  while (openHandles.length) await openHandles.pop()?.close();
});

async function start(
  ctxOver: Parameters<typeof vaultToolContext>[0] = {},
  hooks: VaultMcpHooks = {},
): Promise<{ handle: VaultMcpHandle; url: string; bearer: string }> {
  const handle = await startVaultMcpServer(vaultToolContext(ctxOver), hooks);
  openHandles.push(handle);
  const bearer = handle.server.headers[0]?.value ?? '';
  return { handle, url: handle.server.url, bearer };
}

/** POST a JSON-RPC message with the correct bearer. */
async function rpc(url: string, bearer: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: bearer },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('the advertised server is loopback HTTP with a 64-hex bearer header', async () => {
  const { handle, url } = await start();
  expect(handle.server.type).toBe('http');
  expect(handle.server.name).toBe('centraid');
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  expect(handle.server.headers[0]?.name).toBe('Authorization');
  expect(handle.server.headers[0]?.value).toMatch(/^Bearer [0-9a-f]{64}$/);
});

test('a request to the wrong path 404s (before the bearer check)', async () => {
  const { url, bearer } = await start();
  const res = await fetch(url.replace('/mcp', '/nope'), {
    method: 'POST',
    headers: { authorization: bearer },
    body: '{}',
  });
  expect(res.status).toBe(404);
});

test('a request with no / bad bearer is refused with 401 and a www-authenticate header', async () => {
  const { url } = await start();
  const res = await fetch(url, { method: 'POST', body: '{}' });
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toBe('Bearer');

  const wrong = await rpc(url, 'Bearer deadbeef', { jsonrpc: '2.0', id: 1, method: 'ping' });
  expect(wrong.status).toBe(401);
});

test('a non-POST method on the route is 405 with an Allow header', async () => {
  const { url, bearer } = await start();
  const res = await fetch(url, { method: 'GET', headers: { authorization: bearer } });
  expect(res.status).toBe(405);
  expect(res.headers.get('allow')).toBe('POST');
});

test('initialize echoes a known protocol version and advertises tools capability', async () => {
  const { url, bearer } = await start();
  const res = await rpc(url, bearer, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26' },
  });
  const body = (await res.json()) as { result: Record<string, unknown> };
  expect(body.result.protocolVersion).toBe('2025-03-26');
  expect(body.result.capabilities).toEqual({ tools: {} });
  expect((body.result.serverInfo as { name: string }).name).toBe('centraid');
});

test('initialize falls back to the default version for an unknown protocol version', async () => {
  const { url, bearer } = await start();
  const res = await rpc(url, bearer, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: 'made-up' },
  });
  const body = (await res.json()) as { result: { protocolVersion: string } };
  expect(body.result.protocolVersion).toBe('2025-06-18');
});

test('ping returns an empty result', async () => {
  const { url, bearer } = await start();
  const res = await rpc(url, bearer, { jsonrpc: '2.0', id: 2, method: 'ping' });
  const body = (await res.json()) as { result: unknown };
  expect(body.result).toEqual({});
});

test('tools/list advertises only the tools the ToolContext can serve', async () => {
  const bare = await start();
  const listBare = await rpc(bare.url, bare.bearer, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/list',
  });
  const bareBody = (await listBare.json()) as { result: { tools: { name: string }[] } };
  expect(bareBody.result.tools.map((t) => t.name)).toEqual(['vault_sql']);

  const full = await start({
    vaultInvoke: () => Promise.resolve({ outcome: 'ok' }),
    vaultContent: () => Promise.resolve({ text: 'hi' }),
  });
  const listFull = await rpc(full.url, full.bearer, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/list',
  });
  const fullBody = (await listFull.json()) as { result: { tools: { name: string }[] } };
  expect(fullBody.result.tools.map((t) => t.name)).toEqual([
    'vault_sql',
    'vault_invoke',
    'vault_content',
  ]);
});

test('tools/call runs the tool, fires both hooks, and returns a non-error result', async () => {
  const starts: unknown[] = [];
  const results: unknown[] = [];
  const { url, bearer } = await start(
    {},
    {
      onStart: (c) => starts.push(c),
      onResult: (c) => results.push(c),
    },
  );
  const res = await rpc(url, bearer, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'vault_sql', arguments: { sql: 'SELECT 1' } },
  });
  const body = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } };
  expect(body.result.isError).toBe(false);
  expect(body.result.content[0]?.text).toBe(JSON.stringify({ rows: [{ one: 1 }] }));
  expect(starts).toHaveLength(1);
  expect(results).toHaveLength(1);
  expect((starts[0] as { toolName: string }).toolName).toBe('vault_sql');
  expect((results[0] as { ok: boolean }).ok).toBe(true);
});

test('an unknown tool name comes back as a successful RPC carrying an error result', async () => {
  const { url, bearer } = await start();
  const res = await rpc(url, bearer, {
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'not_a_tool', arguments: {} },
  });
  const body = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } };
  expect(body.result.isError).toBe(true);
  expect(body.result.content[0]?.text).toMatch(/unknown tool "not_a_tool"/);
});

test('tools/call with non-object arguments coerces to {} (surfaced as a tool error here)', async () => {
  const { url, bearer } = await start();
  const res = await rpc(url, bearer, {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'vault_sql', arguments: ['not', 'an', 'object'] },
  });
  const body = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } };
  // Empty args → vault_sql reports its usage error rather than crashing.
  expect(body.result.isError).toBe(true);
  expect(body.result.content[0]?.text).toMatch(/requires/);
});

test('a tool whose runner throws returns isError with the failure message', async () => {
  const { url, bearer } = await start({
    vaultSql: () => {
      throw new Error('db exploded');
    },
  });
  const res = await rpc(url, bearer, {
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { name: 'vault_sql', arguments: { sql: 'SELECT 1' } },
  });
  const body = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } };
  expect(body.result.isError).toBe(true);
  expect(body.result.content[0]?.text).toMatch(/db exploded/);
});

test('a throwing dispatch (hook) is caught and returned as a -32603 JSON-RPC error', async () => {
  const { url, bearer } = await start(
    {},
    {
      onStart: () => {
        throw new Error('hook boom');
      },
    },
  );
  const res = await rpc(url, bearer, {
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: 'vault_sql', arguments: { sql: 'SELECT 1' } },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { error: { code: number; message: string } };
  expect(body.error.code).toBe(-32603);
  expect(body.error.message).toBe('hook boom');
});

test('a notification (no id) is acknowledged with 202 and no body', async () => {
  const { url, bearer } = await start();
  const res = await rpc(url, bearer, { jsonrpc: '2.0', method: 'notifications/initialized' });
  expect(res.status).toBe(202);
  expect(await res.text()).toBe('');
});

test('an unknown method with an id returns method-not-found (-32601)', async () => {
  const { url, bearer } = await start();
  const res = await rpc(url, bearer, { jsonrpc: '2.0', id: 10, method: 'resources/list' });
  const body = (await res.json()) as { error: { code: number } };
  expect(body.error.code).toBe(-32601);
});

test('invalid JSON is a -32700 parse error', async () => {
  const { url, bearer } = await start();
  const res = await rpc(url, bearer, 'this is not json');
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: { code: number } };
  expect(body.error.code).toBe(-32700);
});

test('a JSON array body is rejected as -32600 (batching is not accepted)', async () => {
  const { url, bearer } = await start();
  const res = await rpc(url, bearer, '[{"jsonrpc":"2.0","id":1,"method":"ping"}]');
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: { code: number } };
  expect(body.error.code).toBe(-32600);
});

test('close is idempotent and the port stops listening afterwards', async () => {
  const { handle, url, bearer } = await start();
  await rpc(url, bearer, { jsonrpc: '2.0', id: 1, method: 'ping' });
  await handle.close();
  await handle.close(); // second close is a no-op, not an error
  await expect(fetch(url, { method: 'POST', body: '{}' })).rejects.toThrow();
});
