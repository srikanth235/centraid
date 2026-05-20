import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolsGroundingBlock } from './tools-grounding.js';

describe('buildToolsGroundingBlock', () => {
  it('returns undefined when no tools are available', () => {
    assert.equal(buildToolsGroundingBlock([]), undefined);
  });

  it('lists native + MCP tools and MCP servers, source-agnostic', () => {
    const block = buildToolsGroundingBlock([
      { name: 'Read', source: 'native', granularity: 'tool' },
      { name: 'github.list_pull_requests', source: 'mcp', granularity: 'tool', server: 'github' },
      { name: 'linear', source: 'mcp', granularity: 'server', server: 'linear' },
    ]);
    assert.ok(block);
    assert.match(block, /### Available host tools/);
    assert.match(block, /`Read` _\(native\)_/);
    assert.match(block, /`github\.list_pull_requests` _\(mcp\)_/);
    assert.match(block, /MCP servers/);
    assert.match(block, /`linear`/);
    assert.match(block, /requires\.tools/);
  });

  it('omits the callable-tools section when only servers are known', () => {
    const block = buildToolsGroundingBlock([
      { name: 'github', source: 'mcp', granularity: 'server', server: 'github' },
    ]);
    assert.ok(block);
    assert.doesNotMatch(block, /\*\*Callable tools\*\*/);
    assert.match(block, /\*\*MCP servers\*\*/);
  });
});
