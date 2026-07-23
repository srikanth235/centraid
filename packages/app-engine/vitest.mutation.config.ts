import { nodeProject } from '@centraid/test-kit/vitest';

export default nodeProject({
  test: {
    name: '@centraid/app-engine-mutation',
    include: ['src/pricing/cost-properties.test.ts'],
  },
});
