import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { claudeToolToHostTool, normalizeCodexTools, normalizeClaudeTools } from './host-tools.js';

describe('claudeToolToHostTool', () => {
  it('maps an MCP tool name `mcp__server__tool` to `server.tool`', () => {
    assert.deepEqual(claudeToolToHostTool('mcp__github__list_pull_requests'), {
      name: 'github.list_pull_requests',
      source: 'mcp',
      server: 'github',
    });
  });

  it('treats a bare tool name as native', () => {
    assert.deepEqual(claudeToolToHostTool('Bash'), { name: 'Bash', source: 'native' });
  });
});

describe('normalizeCodexTools', () => {
  it('keeps function tools with their JSON input schema', () => {
    const tools = normalizeCodexTools([
      {
        type: 'function',
        name: 'exec_command',
        description: 'Runs a command.',
        parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
      },
    ]);
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, 'exec_command');
    assert.equal(tools[0]?.source, 'native');
    assert.equal(tools[0]?.description, 'Runs a command.');
    assert.deepEqual(tools[0]?.inputSchema, {
      type: 'object',
      properties: { cmd: { type: 'string' } },
      required: ['cmd'],
    });
  });

  it('maps a native provider tool (no name/schema) by its `type`', () => {
    const tools = normalizeCodexTools([{ type: 'web_search', external_web_access: true }]);
    assert.deepEqual(tools, [{ name: 'web_search', source: 'native' }]);
  });
});

describe('normalizeClaudeTools', () => {
  it('keeps native + MCP tools with descriptions and input schemas', () => {
    const tools = normalizeClaudeTools([
      { name: 'Read', description: 'Read a file.', input_schema: { type: 'object' } },
      {
        name: 'mcp__github__list_pull_requests',
        description: 'List PRs.',
        input_schema: { type: 'object', properties: { repo: { type: 'string' } } },
      },
    ]);
    assert.deepEqual(tools[0], {
      name: 'Read',
      source: 'native',
      description: 'Read a file.',
      inputSchema: { type: 'object' },
    });
    assert.equal(tools[1]?.name, 'github.list_pull_requests');
    assert.equal(tools[1]?.source, 'mcp');
    assert.equal(tools[1]?.server, 'github');
    assert.deepEqual(tools[1]?.inputSchema, {
      type: 'object',
      properties: { repo: { type: 'string' } },
    });
  });
});
