import { describe, expect, test } from 'vitest';

import { intentPayloadHash } from './payload-hash.js';

describe('intent payload hash', () => {
  test('is stable across object key insertion order and changes with payload', async () => {
    const first = await intentPayloadHash({
      appId: 'agenda',
      action: 'create',
      input: { title: 'Meeting', attendees: ['a', 'b'] },
    });
    const reordered = await intentPayloadHash({
      appId: 'agenda',
      action: 'create',
      input: { attendees: ['a', 'b'], title: 'Meeting' },
    });
    const changed = await intentPayloadHash({
      appId: 'agenda',
      action: 'create',
      input: { attendees: ['a'], title: 'Meeting' },
    });
    expect(first).toBe(reordered);
    expect(first).not.toBe(changed);
  });
});
