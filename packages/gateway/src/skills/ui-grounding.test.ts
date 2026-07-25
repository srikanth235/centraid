// UI grounding blocks for builder turns (issue #545 B7).

import { expect, test } from 'vitest';
import { buildUiGroundingBlocks } from './ui-grounding.js';

test('buildUiGroundingBlocks returns the five design-system sections', () => {
  const blocks = buildUiGroundingBlocks();
  expect(blocks).toHaveLength(5);
  const titles = blocks.map((b) => b.split('\n')[0]);
  expect(titles).toEqual([
    '### Design tokens (use these — do not invent colors or sizes)',
    '### Icon set',
    '### Component primitives',
    '### UI/UX rules (non-negotiable)',
    '### Reference implementation',
  ]);
  const joined = blocks.join('\n\n');
  // Token CSS is inlined so the agent sees the live contract.
  expect(joined).toContain('--accent');
  expect(joined).toContain('```css');
});

test('buildUiGroundingBlocks is pure — identical successive calls', () => {
  expect(buildUiGroundingBlocks()).toEqual(buildUiGroundingBlocks());
});
