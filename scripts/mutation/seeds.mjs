/**
 * Mutation seed catalog (#532). Shared by the nightly/per-PR runner.
 */

/**
 * @typedef {{
 *   id: string;
 *   label: string;
 *   cwd: string;
 *   config: string;
 *   report: string;
 *   watch: string[];
 * }} MutationSeed
 */

/** Paths that force every seed to re-run on the per-PR affected lane. */
export const MUTATION_GLOBAL_WATCH = [
  'scripts/mutation/run.mjs',
  'scripts/mutation/seeds.mjs',
  'tests/mutation-floors.json',
  'package.json',
  'bun.lock',
];

/** @type {MutationSeed[]} */
export const MUTATION_SEEDS = [
  {
    id: 'packages/vault',
    label: 'vault',
    cwd: 'packages/vault',
    config: 'stryker.config.mjs',
    report: 'artifacts/mutation/vault-report.json',
    watch: [
      'packages/vault/src/blob/custody-proven.ts',
      'packages/vault/src/blob/custody-properties.test.ts',
      'packages/vault/stryker.config.mjs',
      'packages/vault/vitest.mutation.config.ts',
    ],
  },
  {
    id: 'packages/client/src/replica',
    label: 'client-replica',
    cwd: 'packages/client',
    config: 'stryker.config.mjs',
    report: 'artifacts/mutation/client-replica-report.json',
    watch: [
      'packages/client/src/replica/intents.ts',
      'packages/client/src/replica/payload-hash.ts',
      'packages/client/src/replica/intent-idempotency-properties.test.ts',
      'packages/client/src/replica/intents.contract.test.ts',
      'packages/client/src/replica/payload-hash-identity.test.ts',
      'packages/client/src/replica/payload-hash-properties.test.ts',
      'packages/client/src/replica/payload-hash.test.ts',
      'packages/client/stryker.config.mjs',
      'packages/client/vitest.mutation.config.ts',
    ],
  },
  {
    id: 'packages/automation',
    label: 'automation',
    cwd: 'packages/automation',
    config: 'stryker.config.mjs',
    report: 'artifacts/mutation/automation-report.json',
    watch: [
      'packages/automation/src/fire/scheduler-ledger.ts',
      'packages/automation/src/fire/scheduler-ledger.contract.test.ts',
      'packages/automation/stryker.config.mjs',
      'packages/automation/vitest.mutation.config.ts',
    ],
  },
  {
    id: 'packages/backup',
    label: 'backup',
    cwd: 'packages/backup',
    config: 'stryker.config.mjs',
    report: 'artifacts/mutation/backup-report.json',
    watch: [
      'packages/backup/src/crypto.ts',
      'packages/backup/src/wal-format.ts',
      'packages/backup/src/crypto-properties.test.ts',
      'packages/backup/src/wal-address-properties.test.ts',
      'packages/backup/stryker.config.mjs',
      'packages/backup/vitest.mutation.config.ts',
    ],
  },
  {
    id: 'packages/blob-format',
    label: 'blob-format',
    cwd: 'packages/blob-format',
    config: 'stryker.config.mjs',
    report: 'artifacts/mutation/blob-format-report.json',
    watch: [
      'packages/blob-format/src/index.ts',
      'packages/blob-format/src/cbsf-properties.test.ts',
      'packages/blob-format/src/cbsf.test.ts',
      'packages/blob-format/stryker.config.mjs',
      'packages/blob-format/vitest.mutation.config.ts',
    ],
  },
  {
    id: 'packages/protocol',
    label: 'protocol',
    cwd: 'packages/protocol',
    config: 'stryker.config.mjs',
    report: 'artifacts/mutation/protocol-report.json',
    watch: [
      'packages/protocol/src/handshake.ts',
      'packages/protocol/src/handshake-properties.test.ts',
      'packages/protocol/src/handshake.test.ts',
      'packages/protocol/stryker.config.mjs',
      'packages/protocol/vitest.mutation.config.ts',
    ],
  },
  {
    id: 'packages/tunnel',
    label: 'tunnel',
    cwd: 'packages/tunnel',
    config: 'stryker.config.mjs',
    report: 'artifacts/mutation/tunnel-report.json',
    watch: [
      'packages/tunnel/src/protocol.ts',
      'packages/tunnel/src/wire-properties.test.ts',
      'packages/tunnel/stryker.config.mjs',
      'packages/tunnel/vitest.mutation.config.ts',
    ],
  },
  {
    id: 'packages/app-engine',
    label: 'app-engine',
    cwd: 'packages/app-engine',
    config: 'stryker.config.mjs',
    report: 'artifacts/mutation/app-engine-report.json',
    watch: [
      'packages/app-engine/src/pricing/cost.ts',
      'packages/app-engine/src/pricing/cost-properties.test.ts',
      'packages/app-engine/stryker.config.mjs',
      'packages/app-engine/vitest.mutation.config.ts',
    ],
  },
];
