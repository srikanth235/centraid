import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMcpList } from './mcp-tools.js';

describe('parseMcpList', () => {
  it('parses Claude Code `name: command - status` lines', () => {
    const raw = [
      'Checking MCP server health...',
      '',
      'github: npx -y @modelcontextprotocol/server-github - ✓ Connected',
      'linear: https://mcp.linear.app/sse (SSE) - ✓ Connected',
      'broken-one: node ./bad.js - ✗ Failed to connect',
    ].join('\n');
    const servers = parseMcpList(raw);
    assert.deepEqual(
      servers.map((s) => s.name),
      ['github', 'linear', 'broken-one'],
    );
    assert.equal(servers[0]?.status, 'Connected');
    assert.match(servers[2]?.status ?? '', /Failed/i);
  });

  it('parses Codex-style bare / whitespace-column lines', () => {
    const raw = ['github', 'slack    npx -y server-slack', 'notion'].join('\n');
    assert.deepEqual(
      parseMcpList(raw).map((s) => s.name),
      ['github', 'slack', 'notion'],
    );
  });

  it('returns [] for the explicit empty-state message', () => {
    assert.deepEqual(parseMcpList('No MCP servers configured.'), []);
  });

  it('dedupes repeated server ids and skips header chrome', () => {
    const raw = ['Configured MCP servers:', 'github: a', 'github: a', 'name'].join('\n');
    assert.deepEqual(
      parseMcpList(raw).map((s) => s.name),
      ['github'],
    );
  });
});
