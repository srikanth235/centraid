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
  "scripts/mutation/run.mjs",
  "scripts/mutation/seeds.mjs",
  "tests/mutation-floors.json",
  "package.json",
  "bun.lock",
];

/** @type {MutationSeed[]} */
export const MUTATION_SEEDS = [
  {
    id: "packages/vault",
    label: "vault",
    cwd: "packages/vault",
    config: "stryker.config.mjs",
    report: "artifacts/mutation/vault-report.json",
    watch: [
      "packages/vault/src/blob/custody-proven.ts",
      "packages/vault/src/blob/custody-properties.test.ts",
      "packages/vault/stryker.config.mjs",
      "packages/vault/vitest.mutation.config.ts",
    ],
  },
  {
    id: "packages/client/src/replica",
    label: "client-replica",
    cwd: "packages/client",
    config: "stryker.config.mjs",
    report: "artifacts/mutation/client-replica-report.json",
    watch: [
      "packages/client/src/replica/intents.ts",
      "packages/client/src/replica/payload-hash.ts",
      "packages/client/src/replica/intent-idempotency-properties.test.ts",
      "packages/client/src/replica/intents.contract.test.ts",
      "packages/client/src/replica/payload-hash-identity.test.ts",
      "packages/client/src/replica/payload-hash-properties.test.ts",
      "packages/client/src/replica/payload-hash.test.ts",
      "packages/client/stryker.config.mjs",
      "packages/client/vitest.mutation.config.ts",
    ],
  },
  {
    id: "packages/automation",
    label: "automation",
    cwd: "packages/automation",
    config: "stryker.config.mjs",
    report: "artifacts/mutation/automation-report.json",
    watch: [
      "packages/automation/src/fire/scheduler-ledger.ts",
      "packages/automation/src/fire/scheduler-ledger.contract.test.ts",
      "packages/automation/stryker.config.mjs",
      "packages/automation/vitest.mutation.config.ts",
    ],
  },
  {
    id: "packages/backup",
    label: "backup",
    cwd: "packages/backup",
    config: "stryker.config.mjs",
    report: "artifacts/mutation/backup-report.json",
    watch: [
      "packages/backup/src/crypto.ts",
      "packages/backup/src/wal-format.ts",
      "packages/backup/src/crypto-properties.test.ts",
      "packages/backup/src/wal-address-properties.test.ts",
      "packages/backup/stryker.config.mjs",
      "packages/backup/vitest.mutation.config.ts",
    ],
  },
  {
    id: "packages/blob-format",
    label: "blob-format",
    cwd: "packages/blob-format",
    config: "stryker.config.mjs",
    report: "artifacts/mutation/blob-format-report.json",
    watch: [
      "packages/blob-format/src/cbsf.ts",
      "packages/blob-format/src/cbsf-properties.test.ts",
      "packages/blob-format/src/cbsf.test.ts",
      "packages/blob-format/stryker.config.mjs",
      "packages/blob-format/vitest.mutation.config.ts",
    ],
  },
  {
    id: "packages/protocol",
    label: "protocol",
    cwd: "packages/protocol",
    config: "stryker.config.mjs",
    report: "artifacts/mutation/protocol-report.json",
    watch: [
      "packages/protocol/src/handshake.ts",
      "packages/protocol/src/handshake-properties.test.ts",
      "packages/protocol/src/handshake.test.ts",
      "packages/protocol/stryker.config.mjs",
      "packages/protocol/vitest.mutation.config.ts",
    ],
  },
  {
    id: "packages/tunnel",
    label: "tunnel",
    cwd: "packages/tunnel",
    config: "stryker.config.mjs",
    report: "artifacts/mutation/tunnel-report.json",
    watch: [
      "packages/tunnel/src/protocol.ts",
      "packages/tunnel/src/wire-properties.test.ts",
      "packages/tunnel/stryker.config.mjs",
      "packages/tunnel/vitest.mutation.config.ts",
    ],
  },
  {
    id: "packages/app-engine",
    label: "app-engine",
    cwd: "packages/app-engine",
    config: "stryker.config.mjs",
    report: "artifacts/mutation/app-engine-report.json",
    watch: [
      "packages/app-engine/src/pricing/cost.ts",
      "packages/app-engine/src/pricing/cost-properties.test.ts",
      "packages/app-engine/stryker.config.mjs",
      "packages/app-engine/vitest.mutation.config.ts",
    ],
  },
  {
    id: "packages/gateway",
    label: "gateway",
    cwd: "packages/gateway",
    config: "stryker.config.mjs",
    report: "artifacts/mutation/gateway-report.json",
    watch: [
      "packages/gateway/src/cli/allowed-hosts.ts",
      "packages/gateway/src/cli/allowed-hosts.test.ts",
      "packages/gateway/src/cli/allowed-hosts-properties.test.ts",
      "packages/gateway/stryker.config.mjs",
      "packages/gateway/vitest.mutation.config.ts",
    ],
  },
  {
    id: "packages/agent-runtime",
    label: "agent-runtime",
    cwd: "packages/agent-runtime",
    config: "stryker.config.mjs",
    report: "artifacts/mutation/agent-runtime-report.json",
    watch: [
      "packages/agent-runtime/src/low-priority.ts",
      "packages/agent-runtime/src/low-priority.test.ts",
      "packages/agent-runtime/src/low-priority-properties.test.ts",
      "packages/agent-runtime/stryker.config.mjs",
      "packages/agent-runtime/vitest.mutation.config.ts",
    ],
  },
  // #656 Layer 3 — the remaining deeply-gated engine packages. Same rule as
  // above: each mutate set is pure logic a property or contract test already
  // defends (see each package's stryker.config.mjs for why those paths, and
  // what was deliberately left out).
  {
    id: "packages/blueprints",
    label: "blueprints",
    cwd: "packages/blueprints",
    config: "stryker.config.mjs",
    report: "artifacts/mutation/blueprints-report.json",
    watch: [
      "packages/blueprints/src/scaffold-files.ts",
      "packages/blueprints/src/app-rewrites.ts",
      "packages/blueprints/src/scaffold-files.test.ts",
      "packages/blueprints/src/scaffold-files-properties.test.ts",
      "packages/blueprints/src/app-rewrites.test.ts",
      "packages/blueprints/stryker.config.mjs",
      "packages/blueprints/vitest.mutation.config.ts",
    ],
  },
  {
    id: "packages/time-engine",
    label: "time-engine",
    cwd: "packages/time-engine",
    config: "stryker.config.mjs",
    report: "artifacts/mutation/time-engine-report.json",
    watch: [
      "packages/time-engine/src/recurrence.ts",
      "packages/time-engine/src/timezone.ts",
      "packages/time-engine/src/recurrence.test.ts",
      "packages/time-engine/src/recurrence-properties.test.ts",
      "packages/time-engine/src/timezone-properties.test.ts",
      "packages/time-engine/stryker.config.mjs",
      "packages/time-engine/vitest.mutation.config.ts",
    ],
  },
  {
    id: "packages/cli",
    label: "cli",
    cwd: "packages/cli",
    config: "stryker.config.mjs",
    report: "artifacts/mutation/cli-report.json",
    watch: [
      "packages/cli/src/auth.ts",
      "packages/cli/src/cli.ts",
      "packages/cli/src/auth.test.ts",
      "packages/cli/src/auth.precedence.test.ts",
      "packages/cli/src/cli.branches.test.ts",
      "packages/cli/src/cli.contract.test.ts",
      "packages/cli/stryker.config.mjs",
      "packages/cli/vitest.mutation.config.ts",
    ],
  },
  {
    id: "packages/design",
    label: "design",
    cwd: "packages/design",
    config: "stryker.config.mjs",
    report: "artifacts/mutation/design-report.json",
    watch: [
      "packages/design/src/css.ts",
      "packages/design/src/typography.ts",
      "packages/design/src/tile.ts",
      "packages/design/src/css-properties.test.ts",
      "packages/design/src/tile-properties.test.ts",
      "packages/design/stryker.config.mjs",
      "packages/design/vitest.mutation.config.ts",
    ],
  },
  {
    id: "apps/oauth-worker",
    label: "oauth-worker",
    cwd: "apps/oauth-worker",
    config: "stryker.config.mjs",
    report: "artifacts/mutation/oauth-worker-report.json",
    watch: [
      "apps/oauth-worker/src/worker.ts",
      "apps/oauth-worker/src/index.test.ts",
      "apps/oauth-worker/src/worker-guards.test.ts",
      "apps/oauth-worker/src/mutation-range.test.ts",
      "apps/oauth-worker/stryker.config.mjs",
      "apps/oauth-worker/vitest.mutation.config.ts",
    ],
  },
  {
    id: "tools/recognition-automations",
    label: "enrichment-service",
    cwd: "tools/recognition-automations",
    config: "stryker.config.mjs",
    report: "artifacts/mutation/recognition-automations-report.json",
    watch: [
      "tools/recognition-automations/src/tokenizer.ts",
      "tools/recognition-automations/src/ctc.ts",
      "tools/recognition-automations/src/nms.ts",
      "tools/recognition-automations/src/tokenizer.test.ts",
      "tools/recognition-automations/src/ctc.test.ts",
      "tools/recognition-automations/src/nms.test.ts",
      "tools/recognition-automations/stryker.config.mjs",
      "tools/recognition-automations/vitest.mutation.config.ts",
    ],
  },
];
