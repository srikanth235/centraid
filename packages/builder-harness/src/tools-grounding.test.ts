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
});
