// Vault tools over the per-turn loopback MCP server: what the agent is
// handed, what the endpoint serves, how the transcript renders it, and that
// no port outlives the turn. Core turn behaviour is in backend.test.ts;
// shared fixtures in test-fixtures.ts.

import { tempDir } from '@centraid/test-kit/temp-dir';
import { expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { notices, runFake, types, vaultToolContext } from './test-fixtures.js';

interface VaultProbe {
  sawServer: boolean;
  serverName?: string;
  url?: string;
  unauthStatus?: number;
  serverInfoName?: string | null;
  tools?: string[];
  callText?: string | null;
  callIsError?: boolean | null;
}

/** Is anything still listening? A closed listener refuses immediately. */
async function stillListening(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: 'POST', body: '{}' });
    return true;
  } catch {
    return false;
  }
}

test('vault tools reach the agent through the loopback MCP server', async () => {
  const dir = await tempDir('acp-vault-');
  const mcpMarker = path.join(dir, 'mcp');
  const vaultMarker = path.join(dir, 'vault');
  const ctx = vaultToolContext();

  const { events } = await runFake({
    extraArgs: [
      '--mode=vault',
      '--mcp-http',
      `--mcp-marker=${mcpMarker}`,
      `--vault-marker=${vaultMarker}`,
    ],
    toolContext: ctx,
  });

  // The agent was handed exactly one HTTP MCP server, on loopback, with a
  // bearer header — the ACP `McpServerHttp` wire shape.
  const advertised = JSON.parse(await fs.readFile(mcpMarker, 'utf8')) as Array<{
    type: string;
    name: string;
    url: string;
    headers: Array<{ name: string; value: string }>;
  }>;
  expect(advertised).toHaveLength(1);
  expect(advertised[0]?.type).toBe('http');
  expect(advertised[0]?.name).toBe('centraid');
  expect(advertised[0]?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  expect(advertised[0]?.headers[0]?.name).toBe('Authorization');
  expect(advertised[0]?.headers[0]?.value).toMatch(/^Bearer [0-9a-f]{64}$/);

  const probe = JSON.parse(await fs.readFile(vaultMarker, 'utf8')) as VaultProbe;
  // An unauthenticated request is refused before any tool runs.
  expect(probe.unauthStatus).toBe(401);
  expect(probe.serverInfoName).toBe('centraid');
  // Only the tools this ToolContext can actually serve are advertised.
  expect(probe.tools).toEqual(['vault_sql']);
  expect(probe.callIsError).toBe(false);
  expect(probe.callText).toBe(JSON.stringify({ rows: [{ one: 1 }] }));

  // The call reached the turn's own runner.
  expect(ctx.calls).toEqual([{ sql: 'SELECT 1' }]);

  // …and the transcript rendered it.
  const start = events.find((e) => e.type === 'tool.start');
  expect(start && start.type === 'tool.start' && start.toolName).toBe('vault_sql');
  expect(start && start.type === 'tool.start' && start.sql).toBe('SELECT 1');
  const result = events.find((e) => e.type === 'tool.result');
  expect(result && result.type === 'tool.result' && result.ok).toBe(true);
  expect(result && result.type === 'tool.result' && result.result).toEqual({ rows: [{ one: 1 }] });

  // No port outlives the turn.
  expect(await stillListening(String(probe.url))).toBe(false);
});

test('vault_invoke / vault_content are advertised only when the turn carries them', async () => {
  const dir = await tempDir('acp-vault-');
  const vaultMarker = path.join(dir, 'vault');
  await runFake({
    extraArgs: ['--mode=vault', '--mcp-http', `--vault-marker=${vaultMarker}`],
    toolContext: vaultToolContext({
      vaultInvoke: () => Promise.resolve({ outcome: 'ok' }),
      vaultContent: () => Promise.resolve({ text: 'hi' }),
    }),
  });
  const probe = JSON.parse(await fs.readFile(vaultMarker, 'utf8')) as VaultProbe;
  expect(probe.tools).toEqual(['vault_sql', 'vault_invoke', 'vault_content']);
});

test('an agent that streams the MCP call itself is not double-rendered', async () => {
  const dir = await tempDir('acp-vault-');
  const vaultMarker = path.join(dir, 'vault');
  const { events } = await runFake({
    extraArgs: ['--mode=vault', '--mcp-http', '--mcp-announce', `--vault-marker=${vaultMarker}`],
    toolContext: vaultToolContext(),
  });
  // The agent announced `mcp__centraid__vault_sql` before dialing, so exactly
  // one tool card is emitted — the agent's, not ours on top of it.
  expect(events.filter((e) => e.type === 'tool.start')).toHaveLength(1);
  expect(events.filter((e) => e.type === 'tool.result')).toHaveLength(1);
  const start = events.find((e) => e.type === 'tool.start');
  expect(start && start.type === 'tool.start' && start.toolName).toBe('mcp__centraid__vault_sql');
});

test('an agent with no HTTP MCP support gets a stdio vault bridge instead of silence', async () => {
  const dir = await tempDir('acp-vault-');
  const mcpMarker = path.join(dir, 'mcp');
  const { events } = await runFake({
    extraArgs: ['--mode=normal', `--mcp-marker=${mcpMarker}`],
    toolContext: vaultToolContext(),
  });
  const advertised = JSON.parse(await fs.readFile(mcpMarker, 'utf8')) as Array<{
    name?: string;
    command?: string;
    type?: string;
  }>;
  expect(advertised).toHaveLength(1);
  expect(advertised[0]?.name).toBe('centraid');
  expect(advertised[0]?.type).toBeUndefined();
  expect(advertised[0]?.command).toBeTruthy();
  expect(notices(events)).toContain('vault_tools_stdio');
  expect(notices(events)).not.toContain('vault_tools_unavailable');
});

test('a turn with no toolContext advertises no MCP server at all', async () => {
  const dir = await tempDir('acp-vault-');
  const mcpMarker = path.join(dir, 'mcp');
  const { events } = await runFake({
    extraArgs: ['--mode=normal', '--mcp-http', `--mcp-marker=${mcpMarker}`],
  });
  expect(JSON.parse(await fs.readFile(mcpMarker, 'utf8'))).toEqual([]);
  expect(notices(events)).not.toContain('vault_tools_unavailable');
});

test('aborting mid-tool-call still closes the vault endpoint', async () => {
  const dir = await tempDir('acp-vault-');
  const vaultMarker = path.join(dir, 'vault');
  const mcpMarker = path.join(dir, 'mcp');
  const { events } = await runFake({
    extraArgs: [
      '--mode=vault',
      '--mcp-http',
      `--mcp-marker=${mcpMarker}`,
      `--vault-marker=${vaultMarker}`,
    ],
    toolContext: vaultToolContext(),
    // Abort the moment the vault tool call starts.
    abortOn: (e) => e.type === 'tool.start',
  });
  expect(types(events)).toContain('aborted');

  const advertised = JSON.parse(await fs.readFile(mcpMarker, 'utf8')) as Array<{ url: string }>;
  expect(await stillListening(String(advertised[0]?.url))).toBe(false);
});
