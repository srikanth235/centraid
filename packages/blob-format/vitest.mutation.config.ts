import { nodeProject } from '@centraid/test-kit/vitest';

export default nodeProject({
  test: {
    name: '@centraid/blob-format-mutation',
    include: ['src/cbsf-properties.test.ts', 'src/cbsf.test.ts'],
  },
});
