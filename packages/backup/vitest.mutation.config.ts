import { nodeProject } from '@centraid/test-kit/vitest';

export default nodeProject({
  test: {
    name: '@centraid/backup-mutation',
    include: ['src/crypto-properties.test.ts', 'src/wal-address-properties.test.ts'],
  },
});
