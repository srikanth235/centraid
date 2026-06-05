import { describe, expect, it } from 'vitest';
import { claudeToolToHostTool, normalizeCodexTools, normalizeClaudeTools } from './host-tools.js';

describe('claudeToolToHostTool', () => {
  it('maps an MCP tool name `mcp__server__tool` to `server.tool`', () => {
    expect(claudeToolToHostTool('mcp__github__list_pull_requests')).toEqual({
      name: 'github.list_pull_requests',
      source: 'mcp',
      server: 'github',
    });
  });

  it('treats a bare tool name as native', () => {
    expect(claudeToolToHostTool('Bash')).toEqual({ name: 'Bash', source: 'native' });
  });

  it('treats an `mcp__`-prefixed name with no server/tool separator as native', () => {
    // No `__` after the prefix → cannot split server from tool → stays native.
    expect(claudeToolToHostTool('mcp__weird')).toEqual({ name: 'mcp__weird', source: 'native' });
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
    expect(tools.length).toBe(1);
    expect(tools[0]?.name).toBe('exec_command');
    expect(tools[0]?.source).toBe('native');
    expect(tools[0]?.description).toBe('Runs a command.');
    expect(tools[0]?.inputSchema).toEqual({
      type: 'object',
      properties: { cmd: { type: 'string' } },
      required: ['cmd'],
    });
  });

  it('maps a native provider tool (no name/schema) by its `type`', () => {
    const tools = normalizeCodexTools([{ type: 'web_search', external_web_access: true }]);
    expect(tools).toEqual([{ name: 'web_search', source: 'native' }]);
  });

  it('keeps a named custom tool but carries no input schema', () => {
    const tools = normalizeCodexTools([
      { type: 'custom', name: 'apply_patch', description: 'Apply a patch.', format: 'freeform' },
    ]);
    expect(tools).toEqual([
      { name: 'apply_patch', source: 'native', description: 'Apply a patch.' },
    ]);
  });

  it('skips non-object entries and entries with neither name nor type', () => {
    const tools = normalizeCodexTools([null, 42, 'str', ['x'], {}, { description: 'no id' }]);
    expect(tools).toEqual([]);
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
    expect(tools[0]).toEqual({
      name: 'Read',
      source: 'native',
      description: 'Read a file.',
      inputSchema: { type: 'object' },
    });
    expect(tools[1]?.name).toBe('github.list_pull_requests');
    expect(tools[1]?.source).toBe('mcp');
    expect(tools[1]?.server).toBe('github');
    expect(tools[1]?.inputSchema).toEqual({
      type: 'object',
      properties: { repo: { type: 'string' } },
    });
  });

  it('skips entries that are not objects or have no name', () => {
    expect(normalizeClaudeTools([null, 'x', 7, {}, { description: 'nameless' }])).toEqual([]);
  });

  it('omits an absent description and input schema rather than emitting undefined keys', () => {
    expect(normalizeClaudeTools([{ name: 'Glob' }])).toEqual([{ name: 'Glob', source: 'native' }]);
  });
});
