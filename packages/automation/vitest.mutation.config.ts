import { nodeProject } from '@centraid/test-kit/vitest';

export default nodeProject({
  test: {
    name: '@centraid/automation-mutation',
    include: ['src/fire/scheduler-ledger.contract.test.ts'],
  },
});
