import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'nightly-scale',
    include: ['tests/scale/**/*.scale.test.ts'],
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    // Nightly scale fixtures build real vaults / CAS files (fsync-per-blob) and
    // round-trip ~160 MiB through the backup engine; slow CI disks need more
    // than the 120 s default before the meaningful assertion even runs.
    testTimeout: 180_000,
  },
});
