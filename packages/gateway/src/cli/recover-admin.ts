/*
 * `centraid-gateway recover` (issue #439 R6) — the CLI shell over the
 * service-layer `recover()` verb (`backup/recover.ts`). Headless Linux daemon
 * installs recover this way, and it is the blank-machine e2e harness: a fresh
 * data dir plus NOTHING but the recovery kit and the provider api-key.
 *
 *   centraid-gateway recover --kit <file> --api-key <key> --data-dir <dir>
 *                            [--at <iso-time>] [--full] [--vault <id>] [--yes]
 *
 * Unlike `backup …`, recover needs NO daemon config file: the provider
 * addressing lives in the kit and the api-key is passed in. It prints the
 * "found your vault" facts (size / as-of / provider / cost class) to stderr,
 * gates a metered-egress home behind `--yes` (the same rule Wave 1's restore
 * gate uses — PROTOCOL.md's `restoreCostClass`), streams phase progress to
 * stderr, and writes the JSON completion report to stdout. It refuses to touch
 * a vault root a live gateway holds. The restore is LAZY by default (defers
 * every blob the provider's attested inventory holds); `--full` materializes
 * every blob. `--at` is point-in-time recovery (issue #408).
 *
 * The recovered gateway's keyring + fenced backup state land under
 * `<data-dir>/backup/` and the vault under `<data-dir>/vault/<vaultId>/`; the
 * quarantine marker fires the first time the daemon mounts it. Resuming BACKUPS
 * (not restore) still needs a `backup` config block pointing at the same
 * provider + api-key — a separate operator step this command reminds them of.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { daemonLayoutFor } from './paths.js';
import { formatBytes, refuseIfDaemonHoldsRoot } from './backup-admin.js';
import {
  discoverRecovery,
  recover,
  type RecoverPhase,
  type RecoveryDiscovery,
} from '../backup/recover.js';

interface RecoverArgs {
  kit?: string;
  apiKey?: string;
  dataDir?: string;
  vault?: string;
  atMs?: number;
  full?: boolean;
  yes?: boolean;
}

function parseRecoverArgs(
  args: string[],
  fail: (msg: string, code?: number) => never,
): RecoverArgs {
  const out: RecoverArgs = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === undefined) continue;
    const take = (): string => {
      const v = args[++i];
      if (v === undefined) fail(`${flag} requires a value`, 2);
      return v;
    };
    if (flag === '--kit') out.kit = take();
    else if (flag === '--api-key') out.apiKey = take();
    else if (flag === '--data-dir') out.dataDir = take();
    else if (flag === '--vault') out.vault = take();
    else if (flag === '--at') {
      const raw = take();
      const ms = Date.parse(raw);
      if (Number.isNaN(ms)) fail(`--at needs an ISO-8601 time, got "${raw}"`, 2);
      out.atMs = ms;
    } else if (flag === '--full') out.full = true;
    else if (flag === '--yes') out.yes = true;
    else fail(`unknown flag "${flag}"`, 2);
  }
  return out;
}

/** Phase → the user-facing progress line wave 4's SSE will echo. */
const PHASE_LINES: Record<RecoverPhase, string> = {
  discovering: 'finding your vault',
  fetching: 'fetching your vault',
  replaying: 'replaying recent changes',
  fencing: 'claiming this machine as the one in charge',
  adopting: 'putting your vault in place',
  warming: 'warming previews',
  done: 'done',
};

/** The "found your vault" facts card (issue #439 R6) — zero machine vocabulary. */
function printFacts(discovery: RecoveryDiscovery): void {
  const size =
    discovery.fullBytes !== undefined ? formatBytes(discovery.fullBytes) : 'an unknown size';
  const asOf =
    discovery.recoveredAsOf !== undefined
      ? new Date(discovery.recoveredAsOf).toISOString()
      : 'an unknown time';
  process.stderr.write(
    `centraid-gateway: found your vault — ${size}, everything safe as of ${asOf}, ` +
      `hosted at ${discovery.target.provider} (${discovery.restoreCostClass ?? 'unknown egress'}).\n`,
  );
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export async function commandRecover(
  args: string[],
  fail: (msg: string, code?: number) => never,
): Promise<void> {
  const parsed = parseRecoverArgs(args, fail);
  if (!parsed.kit || !parsed.apiKey || !parsed.dataDir) {
    fail(
      'usage: recover --kit <file> --api-key <key> --data-dir <dir> ' +
        '[--at <iso-time>] [--full] [--vault <id>] [--yes]',
      2,
    );
  }
  const layout = daemonLayoutFor(parsed.dataDir);
  refuseIfDaemonHoldsRoot(layout.vaultDir, fail);

  let kitDocument: unknown;
  try {
    kitDocument = JSON.parse(readFileSync(parsed.kit, 'utf8'));
  } catch (err) {
    fail(
      `could not read recovery kit "${parsed.kit}": ${err instanceof Error ? err.message : String(err)}`,
      2,
    );
  }

  // Discovery + the "found your vault" card + the metered-egress gate — all
  // BEFORE any restore work, and the provider client is reused by recover().
  let discovery: RecoveryDiscovery;
  try {
    discovery = await discoverRecovery({
      kitDocument,
      apiKey: parsed.apiKey,
      ...(parsed.vault !== undefined ? { vaultId: parsed.vault } : {}),
      ...(parsed.atMs !== undefined ? { at: parsed.atMs } : {}),
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), 2);
  }
  printFacts(discovery);

  if (discovery.restoreCostClass === 'metered-egress' && !parsed.yes) {
    const fullSize =
      discovery.fullBytes !== undefined ? formatBytes(discovery.fullBytes) : 'an unknown amount';
    const line =
      !parsed.full && discovery.lazyAvailable
        ? 'recovery is lazy by default and downloads only the vault database plus any blob the ' +
          'remote does not already hold; originals stream in on demand afterward. '
        : `a --full recovery downloads the whole library (~${fullSize}). `;
    fail(
      `this home is metered-egress — recovering will incur egress charges. ${line}` +
        'Re-run with --yes to proceed.',
      2,
    );
  }

  const report = await recover({
    kitDocument,
    apiKey: parsed.apiKey,
    vaultRoot: layout.vaultDir,
    backupDir: layout.backupDir ?? path.join(parsed.dataDir, 'backup'),
    provider: discovery.provider,
    ...(parsed.vault !== undefined ? { vaultId: parsed.vault } : {}),
    ...(parsed.atMs !== undefined ? { at: parsed.atMs } : {}),
    ...(parsed.full ? { full: true } : {}),
    onPhase: (phase) => process.stderr.write(`centraid-gateway: ${PHASE_LINES[phase]}\n`),
    log: {
      info: () => undefined,
      warn: (m) => process.stderr.write(`centraid-gateway: ${m}\n`),
    },
  });

  printJson(report);
  const previews = report.previews.warmed
    ? `previews warmed (${report.previews.tiniesWarmed}/${report.previews.tiniesTotal} in ` +
      `${report.previews.timeToUsableGridMs}ms)`
    : `previews on demand (${report.previews.reason})`;
  process.stderr.write(
    `centraid-gateway: recovered vault ${report.vaultId} to ${path.resolve(report.vaultDir)} — ` +
      `as of ${new Date(report.recoveredAsOf).toISOString()}${report.truncated ? ' (TRUNCATED — objects were missing)' : ''}, ` +
      `${report.skippedBlobs} blob(s) deferred, ${previews}. Generation fenced at ${report.generation}: ` +
      "the old machine's next backup will be refused. The vault parks its outbox and flags automations/" +
      'connections the first time the gateway mounts it. To resume BACKUPS, add a "backup" config block ' +
      'pointing at the same provider + api-key, then start the daemon.\n',
  );
}
