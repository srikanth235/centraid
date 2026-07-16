import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@centraid/mobile',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The upload suites seal and unseal real multi-part payloads and rebuild the
    // queue from disk across many simulated process deaths; they sit near the
    // 5s default on a quiet machine and time out under a full-repo run.
    testTimeout: 30_000,
  },
});
