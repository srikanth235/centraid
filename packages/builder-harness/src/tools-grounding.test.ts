import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolsGroundingBlock } from './tools-grounding.js';

describe('buildToolsGroundingBlock', () => {
  it('returns undefined when no tools are available', () => {
    assert.equal(buildToolsGroundingBlock([]), undefined);
  });

  it('lists native + MCP tools source-agnostically with descriptions', () => {
    const block = buildToolsGroundingBlock([
      { name: 'Read', source: 'native' },
      {
        name: 'github.list_pull_requests',
        source: 'mcp',
        server: 'github',
        description: 'List PRs.',
      },
    ]);
    assert.ok(block);
    assert.match(block, /### Available host tools/);
    assert.match(block, /`Read` _\(native\)_/);
    assert.match(block, /`github\.list_pull_requests` _\(mcp\)_ — List PRs\./);
    assert.match(block, /requires\.tools/);
    assert.match(block, /requires\.mcps/);
  });

  it('renders each tool’s JSON args schema verbatim', () => {
    const block = buildToolsGroundingBlock([
      {
        name: 'exec_command',
        source: 'native',
        description: 'Runs a command.',
        inputSchema: {
          type: 'object',
          properties: { cmd: { type: 'string' } },
          required: ['cmd'],
        },
      },
    ]);
    assert.ok(block);
    assert.match(block, /args schema:/);
    assert.match(
      block,
      /`\{"type":"object","properties":\{"cmd":\{"type":"string"\}\},"required":\["cmd"\]\}`/,
    );
  });
});
