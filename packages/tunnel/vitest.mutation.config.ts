import { nodeProject } from '@centraid/test-kit/vitest';

export default nodeProject({
  test: {
    name: '@centraid/tunnel-mutation',
    include: ['src/wire-properties.test.ts'],
  },
});
