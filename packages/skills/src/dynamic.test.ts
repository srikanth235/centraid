import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildToolsGroundingBlock } from './dynamic.js';
import type { HostTool } from '@centraid/agent-runtime';

test('buildToolsGroundingBlock returns undefined for empty list', () => {
  assert.equal(buildToolsGroundingBlock([]), undefined);
});

test('buildToolsGroundingBlock lists tool names + schemas', () => {
  const tools: HostTool[] = [
    {
      name: 'github.list_prs',
      source: 'mcp',
      description: 'List PRs',
      inputSchema: { type: 'object' },
    },
  ];
  const block = buildToolsGroundingBlock(tools);
  assert.ok(block?.includes('github.list_prs'));
  assert.ok(block?.includes('args schema'));
});
