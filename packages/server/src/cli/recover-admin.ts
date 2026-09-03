import { readFileSync } from "node:fs";
import path from "node:path";

import { deriveBackupSourceInstanceId } from "../backup/backup-state.js";
import { discoverRecovery, recover } from "../backup/recover.js";
import type { RecoverPhase, RecoveryDiscovery } from "../backup/recover.js";
import { GatewayDatabase, GatewayLockError } from "../serve/gateway-db.js";
import { formatBytes } from "./backup-admin.js";
import { daemonKeyStore } from "./key-store.js";
import { daemonLayoutFor } from "./paths.js";

interface RecoverArgs {
  kit?: string;
  apiKey?: string;
  passwordFile?: string;
  dataDir?: string;
  vault?: string;
  atMs?: number;
  full?: boolean;
  yes?: boolean;
}

function parseRecoverArgs(
  args: string[],
  fail: (msg: string, code?: number) => never
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
    if (flag === "--kit") out.kit = take();
    else if (flag === "--api-key") out.apiKey = take();
    else if (flag === "--password-file") out.passwordFile = take();
    else if (flag === "--data-dir") out.dataDir = take();
    else if (flag === "--vault") out.vault = take();
    else if (flag === "--at") {
      const raw = take();
      const ms = Date.parse(raw);
      if (Number.isNaN(ms))
        fail(`--at needs an ISO-8601 time, got "${raw}"`, 2);
      out.atMs = ms;
    } else if (flag === "--full") out.full = true;
    else if (flag === "--yes") out.yes = true;
    else fail(`unknown flag "${flag}"`, 2);
  }
  return out;
}

const PHASE_LINES: Record<RecoverPhase, string> = {
  discovering: "finding your vault",
  fetching: "fetching your vault",
  replaying: "replaying recent changes",
  fencing: "claiming this machine as the one in charge",
  adopting: "putting your vault in place",
  warming: "warming previews",
  done: "done",
};

function printFacts(discovery: RecoveryDiscovery): void {
  const size =
    discovery.fullBytes === undefined
      ? "an unknown size"
      : formatBytes(discovery.fullBytes);
  const asOf =
    discovery.recoveredAsOf === undefined
      ? "an unknown time"
      : new Date(discovery.recoveredAsOf).toISOString();
  process.stderr.write(
    `centraid-gateway: found your vault — ${size}, everything safe as of ${asOf}, ` +
      `hosted at ${discovery.target.provider} (${discovery.restoreCostClass ?? "unknown egress"}).\n`
  );
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export async function commandRecover(
  args: string[],
  fail: (msg: string, code?: number) => never
): Promise<void> {
  const parsed = parseRecoverArgs(args, fail);
  if (
    !parsed.kit ||
    !parsed.passwordFile ||
    !parsed.apiKey ||
    !parsed.dataDir
  ) {
    fail(
      "usage: recover --kit <file> --password-file <file> --api-key <key> --data-dir <dir> " +
        "[--at <iso-time>] [--full] [--vault <id>] [--yes]",
      2
    );
  }
  let password: string;
  try {
    password = readFileSync(parsed.passwordFile, "utf8").replace(/\r?\n$/u, "");
  } catch (error) {
    fail(
      `could not read recovery-kit password file "${parsed.passwordFile}": ${
        error instanceof Error ? error.message : String(error)
      }`,
      2
    );
  }
  if (password.length === 0) fail("recovery-kit password file is empty", 2);
  const layout = daemonLayoutFor(parsed.dataDir);
  let gatewayDatabase: GatewayDatabase;
  try {
    gatewayDatabase = GatewayDatabase.open(parsed.dataDir, {
      lock: "exclusive",
    });
  } catch (error) {
    if (error instanceof GatewayLockError) {
      fail(
        "the running daemon holds gateway.db — stop it before recovering into this data dir",
        2
      );
    }
    throw error;
  }
  try {
    const keyStore = daemonKeyStore(layout.keysDir);
    const sourceInstanceId = deriveBackupSourceInstanceId(
      keyStore.loadOrCreate("endpoint-key.bin")
    );

    let kitDocument: unknown;
    try {
      kitDocument = JSON.parse(readFileSync(parsed.kit, "utf8"));
    } catch (error) {
      fail(
        `could not read recovery kit "${parsed.kit}": ${error instanceof Error ? error.message : String(error)}`,
        2
      );
    }

    let discovery: RecoveryDiscovery;
    try {
      discovery = await discoverRecovery({
        kitDocument,
        password,
        apiKey: parsed.apiKey,
        ...(parsed.vault === undefined ? {} : { vaultId: parsed.vault }),
        ...(parsed.atMs === undefined ? {} : { at: parsed.atMs }),
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error), 2);
    }
    printFacts(discovery);

    if (discovery.restoreCostClass === "metered-egress" && !parsed.yes) {
      const fullSize =
        discovery.fullBytes === undefined
          ? "an unknown amount"
          : formatBytes(discovery.fullBytes);
      const line =
        !parsed.full && discovery.lazyAvailable
          ? "recovery is lazy by default and downloads only the vault database plus any blob the " +
            "remote does not already hold; originals stream in on demand afterward. "
          : `a --full recovery downloads the whole library (~${fullSize}). `;
      fail(
        `this home is metered-egress — recovering will incur egress charges. ${line}` +
          "Re-run with --yes to proceed.",
        2
      );
    }

    const report = await recover({
      kitDocument,
      password,
      apiKey: parsed.apiKey,
      vaultRoot: layout.vaultDir,
      gatewayDatabase,
      keyStore,
      sourceInstanceId,
      provider: discovery.provider,
      ...(parsed.vault === undefined ? {} : { vaultId: parsed.vault }),
      ...(parsed.atMs === undefined ? {} : { at: parsed.atMs }),
      ...(parsed.full ? { full: true } : {}),
      onPhase: (phase) =>
        process.stderr.write(`centraid-gateway: ${PHASE_LINES[phase]}\n`),
      log: {
        info: () => undefined,
        warn: (m) => process.stderr.write(`centraid-gateway: ${m}\n`),
      },
    });

    printJson(report);

    const rec = report.reconcile;
    if (rec.lost.length > 0) {
      process.stderr.write(
        `\ncentraid-gateway: CRITICAL — ${rec.lost.length} blob(s) are permanently LOST. The provider ` +
          "no longer holds them and the snapshot did not carry them, so the content they back is " +
          `unreadable. blob_replica was corrected. Shas: ${rec.lost.slice(0, 10).join(", ")}` +
          `${rec.lost.length > 10 ? `, +${rec.lost.length - 10} more` : ""}.\n\n`
      );
    } else if (rec.repinned.length > 0) {
      process.stderr.write(
        `centraid-gateway: ${rec.repinned.length} blob(s) the provider had dropped were re-pinned from ` +
          "the snapshot and will re-upload on the next backup.\n"
      );
    }

    const previews = report.previews.warmed
      ? `previews warmed (${report.previews.tiniesWarmed}/${report.previews.tiniesTotal} in ` +
        `${report.previews.timeToUsableGridMs}ms)`
      : `previews on demand (${report.previews.reason})`;
    process.stderr.write(
      `centraid-gateway: recovered vault ${report.vaultId} to ${path.resolve(report.vaultDir)} — ` +
        `as of ${new Date(report.recoveredAsOf).toISOString()}${report.truncated ? " (TRUNCATED — objects were missing)" : ""}, ` +
        `${report.skippedBlobs} blob(s) deferred, ${previews}. Generation fenced at ${report.generation}: ` +
        "the old machine's next backup will be refused. The vault parks its outbox and flags automations/" +
        'connections the first time the gateway mounts it. To resume BACKUPS, add a "backup" config block ' +
        "pointing at the same provider + api-key, then start the daemon.\n"
    );
  } finally {
    gatewayDatabase.close();
  }
}
