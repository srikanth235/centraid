import { expect, test } from 'vitest';
import { buildToolsGroundingBlock } from './dynamic.js';
import type { HostTool } from '@centraid/agent-runtime';

test('buildToolsGroundingBlock returns undefined for empty list', () => {
  expect(buildToolsGroundingBlock([])).toBe(undefined);
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
  expect(block?.includes('github.list_prs')).toBeTruthy();
  expect(block?.includes('args schema')).toBeTruthy();
});
