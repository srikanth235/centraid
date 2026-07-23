import { nodeProject } from '@centraid/test-kit/vitest';

export default nodeProject({
  test: {
    name: '@centraid/vault-mutation',
    include: ['src/blob/custody-properties.test.ts'],
  },
});
