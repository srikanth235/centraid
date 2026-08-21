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
    id: "packages/server/src/automation",
    label: "automation",
    cwd: "packages/server",
    config: "stryker.automation.config.mjs",
    report: "artifacts/mutation/automation-report.json",
    watch: [
      "packages/server/src/automation/fire/scheduler-ledger.ts",
      "packages/server/src/automation/fire/scheduler-ledger.contract.test.ts",
      "packages/server/stryker.automation.config.mjs",
      "packages/server/vitest.automation.mutation.config.ts",
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
    id: "packages/core/src/blob",
    label: "blob-format",
    cwd: "packages/core",
    config: "stryker.blob.config.mjs",
    report: "artifacts/mutation/blob-format-report.json",
    watch: [
      "packages/core/src/blob/cbsf.ts",
      "packages/core/src/blob/cbsf-properties.test.ts",
      "packages/core/src/blob/cbsf.test.ts",
      "packages/core/stryker.blob.config.mjs",
      "packages/core/vitest.blob.mutation.config.ts",
    ],
  },
  {
    id: "packages/core/src/protocol",
    label: "protocol",
    cwd: "packages/core",
    config: "stryker.protocol.config.mjs",
    report: "artifacts/mutation/protocol-report.json",
    watch: [
      "packages/core/src/protocol/handshake.ts",
      "packages/core/src/protocol/handshake-properties.test.ts",
      "packages/core/src/protocol/handshake.test.ts",
      "packages/core/stryker.protocol.config.mjs",
      "packages/core/vitest.protocol.mutation.config.ts",
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
    id: "packages/server/src/engine",
    label: "app-engine",
    cwd: "packages/server",
    config: "stryker.engine.config.mjs",
    report: "artifacts/mutation/app-engine-report.json",
    watch: [
      "packages/server/src/engine/pricing/cost.ts",
      "packages/server/src/engine/pricing/cost-properties.test.ts",
      "packages/server/stryker.engine.config.mjs",
      "packages/server/vitest.engine.mutation.config.ts",
    ],
  },
  {
    id: "packages/server",
    label: "gateway",
    cwd: "packages/server",
    config: "stryker.config.mjs",
    report: "artifacts/mutation/gateway-report.json",
    watch: [
      "packages/server/src/cli/allowed-hosts.ts",
      "packages/server/src/cli/allowed-hosts.test.ts",
      "packages/server/src/cli/allowed-hosts-properties.test.ts",
      "packages/server/stryker.config.mjs",
      "packages/server/vitest.mutation.config.ts",
    ],
  },
  {
    id: "packages/server/src/acp",
    label: "agent-runtime",
    cwd: "packages/server",
    config: "stryker.acp.config.mjs",
    report: "artifacts/mutation/agent-runtime-report.json",
    watch: [
      "packages/server/src/acp/low-priority.ts",
      "packages/server/src/acp/low-priority.test.ts",
      "packages/server/src/acp/low-priority-properties.test.ts",
      "packages/server/stryker.acp.config.mjs",
      "packages/server/vitest.acp.mutation.config.ts",
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
      "packages/blueprints/src/app-meta.ts",
      "packages/blueprints/src/app-rewrites.ts",
      "packages/blueprints/src/app-meta.test.ts",
      "packages/blueprints/src/app-meta-properties.test.ts",
      "packages/blueprints/src/app-rewrites.test.ts",
      "packages/blueprints/stryker.config.mjs",
      "packages/blueprints/vitest.mutation.config.ts",
    ],
  },
  {
    id: "packages/core/src/time",
    label: "time-engine",
    cwd: "packages/core",
    config: "stryker.time.config.mjs",
    report: "artifacts/mutation/time-engine-report.json",
    watch: [
      "packages/core/src/time/recurrence.ts",
      "packages/core/src/time/timezone.ts",
      "packages/core/src/time/recurrence.test.ts",
      "packages/core/src/time/recurrence-properties.test.ts",
      "packages/core/src/time/timezone-properties.test.ts",
      "packages/core/stryker.time.config.mjs",
      "packages/core/vitest.time.mutation.config.ts",
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
    id: "packages/model-runtime",
    label: "model-runtime",
    cwd: "packages/model-runtime",
    config: "stryker.config.mjs",
    report: "artifacts/mutation/model-runtime-report.json",
    watch: [
      "packages/model-runtime/src/tokenizer.ts",
      "packages/model-runtime/src/ctc.ts",
      "packages/model-runtime/src/nms.ts",
      "packages/model-runtime/src/tokenizer.test.ts",
      "packages/model-runtime/src/ctc.test.ts",
      "packages/model-runtime/src/nms.test.ts",
      "packages/model-runtime/stryker.config.mjs",
      "packages/model-runtime/vitest.mutation.config.ts",
    ],
  },
];
