import { nodeProject } from '@centraid/test-kit/vitest';

export default nodeProject({
  test: {
    name: '@centraid/protocol-mutation',
    include: ['src/handshake-properties.test.ts', 'src/handshake.test.ts'],
  },
});
