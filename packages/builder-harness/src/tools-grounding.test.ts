import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolsGroundingBlock } from './tools-grounding.js';

describe('buildToolsGroundingBlock', () => {
  it('returns undefined when no servers are configured', () => {
    assert.equal(buildToolsGroundingBlock([]), undefined);
  });

  it('lists each server and teaches the requires / ctx.tool rules', () => {
    const block = buildToolsGroundingBlock([
      { name: 'github', status: 'Connected' },
      { name: 'linear' },
    ]);
    assert.ok(block);
    assert.match(block, /### Available host tools/);
    assert.match(block, /`github` — Connected/);
    assert.match(block, /`linear`/);
    assert.match(block, /requires\.mcps/);
    assert.match(block, /requires\.tools/);
  });
});
