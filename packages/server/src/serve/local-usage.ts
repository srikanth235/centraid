/*
 * Local disk accounting by component (#544) — "how much of THIS
 * machine's disk is Centraid using, and where did it go?".
 *
 * The `disk` health probe (disk-health.ts) already answers "how much room is
 * left on the volume", and `storage-routes.ts`'s `storage/usage` answers "how
 * many bytes does the PROVIDER hold". Neither answers the owner's actual
 * question on a personal machine, because the two biggest local consumers —
 * the blob CAS (`blobs/`) and the app code store (`code/`) — appear in
 * neither. This module walks the real directories behind `GatewayPaths` and
 * reports bytes per named component.
 *
 * Cost discipline. A recursive walk of a blob CAS with tens of thousands of
 * objects is not something to put on a timer, and it is not something to run
 * once per poll of a UI that refreshes every 10s. So this follows the SAME
 * cache-with-TTL + stale-while-refresh contract `StorageUsagePoller` uses for
 * the provider's metered `/usage` endpoint: the FIRST read awaits the walk;
 * every read after that returns the cached report immediately and kicks a
 * background refresh only once the cache is older than the TTL. A failed walk
 * keeps serving the last-known-good report rather than blanking numbers that
 * were true a moment ago.
 *
 * Honesty about what a byte count means: sizes are `stat.size` sums (apparent
 * size), NOT allocated blocks, and hard-linked or sparse files are counted
 * once per path seen. A directory the process cannot read contributes what it
 * could read plus an `unreadable` note — never a throw, and never a silently
 * smaller number with no explanation.
 */

import { promises as fs, statfsSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";

/**
 * The vocabulary of local components. These are stable identifiers the UI
 * keys its labels/colours off — renaming one is a wire change.
 *
 *   ledger       — `journal.db` (+ `-wal`): the audit ladder AND the
 *                  conversation ledger. The file that reaches gigabytes, and
 *                  the one `journalLimitBytes` (storage-limits.ts) governs.
 *   vault-db     — `vault.db` (+ `-wal`): the ontology itself.
 *   attachments  — `blobs/`: the local CAS — every attachment, preview,
 *                  derivative, and archived journal/conversation segment.
 *   apps         — `apps/`: per-app data directories.
 *   code         — `code/`: the app code store (a bare git repo + worktrees).
 *   logs         — `logsDir`: rotated JSONL gateway logs.
 *   cache        — harness scratch and reusable backup code bundles. Derived;
 *                  safe to wipe.
 *   templates    — `templatesCacheDir`: the pulled template cache.
 */
export type LocalComponentId =
  | "ledger"
  | "vault-db"
  | "attachments"
  | "apps"
  | "code"
  | "logs"
  | "cache"
  | "templates";

export interface LocalComponentUsage {
  component: LocalComponentId;
  bytes: number;
  /** File count for directory components; `null` for the DB-file components. */
  files: number | null;
  /** Set when part of the tree could not be read — the byte count is a floor. */
  unreadable?: string;
}

export interface LocalVaultUsage {
  vaultId: string;
  name?: string;
  bytes: number;
  components: LocalComponentUsage[];
}

export interface LocalUsageReport {
  /** Epoch ms the walk that produced this report finished. */
  scannedAt: number;
  /** Every byte Centraid accounts for on this machine. */
  totalBytes: number;
  /** Gateway-level components (not attributable to one vault). */
  components: LocalComponentUsage[];
  /** Per-vault breakdown; each vault's `components` sum to its `bytes`. */
  vaults: LocalVaultUsage[];
  /** The volume the vault root sits on. `null` when statfs is unavailable. */
  disk: { freeBytes: number; totalBytes: number } | null;
  /** Set when the most recent refresh threw — figures are last-known-good. */
  error?: string;
}

/** Default cache TTL. A full-tree walk is the expensive part; the UI polls far
 *  more often than the numbers meaningfully move. */
const DEFAULT_TTL_MS = 60_000;

export interface LocalUsageVaultEntry {
  vaultId: string;
  name?: string;
  /** The vault's directory (holds `vault.db`, `journal.db`, `blobs/`, …). */
  dir: string;
  /** This vault's disposable cache dir, when the host pins one outside `dir`. */
  cacheDir?: string;
}

export interface LocalUsageOptions {
  /** Root directory to `statfs` — the vault registry's root. */
  rootDir: string;
  /** Mounted vaults to break down. Read fresh on every walk. */
  vaults: () => LocalUsageVaultEntry[];
  /** Gateway-level directories, by component. Absent/undefined ⇒ skipped. */
  gatewayDirs: () => Partial<Record<LocalComponentId, string | undefined>>;
  /** Cache staleness before a background refresh fires. Default 60s. */
  ttlMs?: number;
  /** Clock override (tests). */
  now?: () => number;
  /** Injectable for tests — defaults to `fs.statfsSync`, `null` on any error. */
  statfs?: (
    dir: string
  ) => { bavail: number; bsize: number; blocks: number } | null;
}

/** One directory's recursive apparent size. Never throws: an unreadable
 *  subtree contributes what it could read and names itself in `unreadable`. */
export async function walkDirBytes(
  dir: string
): Promise<{ bytes: number; files: number; unreadable?: string }> {
  let bytes = 0;
  let files = 0;
  let unreadable: string | undefined;
  // Iterative: a deep `code/` worktree tree should not consume stack depth,
  // and this keeps one shared `unreadable` note rather than a per-level throw.
  const queue: string[] = [dir];
  async function walkNextDirectory(): Promise<void> {
    const current = queue.pop();
    if (!current) return;
    const currentDir = current;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A component directory that was never created is 0 bytes, not an error.
      if (code !== "ENOENT")
        unreadable ??= `${currentDir}: ${code ?? "unreadable"}`;
      return walkNextDirectory();
    }
    async function inspectNextEntry(index: number): Promise<void> {
      const entry = entries[index];
      if (!entry) return;
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile()) {
        // Symlinks are NOT followed — a link into the user's home would
        // otherwise bill their whole disk to Centraid.
        try {
          const stat = await fs.stat(full);
          bytes += stat.size;
          files += 1;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT")
            unreadable ??= `${full}: ${code ?? "unreadable"}`;
        }
      }
      return inspectNextEntry(index + 1);
    }
    await inspectNextEntry(0);
    return walkNextDirectory();
  }
  await walkNextDirectory();
  return { bytes, files, ...(unreadable ? { unreadable } : {}) };
}

/** Sum of a fixed set of sibling files, missing ones counting zero. */
async function fileBytes(
  dir: string,
  names: readonly string[]
): Promise<number> {
  const sizes = await Promise.all(
    names.map((name) =>
      fs
        .stat(path.join(dir, name))
        .then((stat) => stat.size)
        .catch(() => 0)
    )
  );
  return sizes.reduce((total, size) => total + size, 0);
}

/** `journal.db` and `vault.db` each carry a `-wal` and a `-shm` sibling; the
 *  `-shm` is a fixed-size shared-memory index, counted for honesty. */
const LEDGER_FILES = [
  "journal.db",
  "journal.db-wal",
  "journal.db-shm",
] as const;
const VAULT_DB_FILES = ["vault.db", "vault.db-wal", "vault.db-shm"] as const;

async function dirComponent(
  component: LocalComponentId,
  dir: string
): Promise<LocalComponentUsage> {
  const walked = await walkDirBytes(dir);
  return {
    component,
    bytes: walked.bytes,
    files: walked.files,
    ...(walked.unreadable ? { unreadable: walked.unreadable } : {}),
  };
}

async function scanVault(
  entry: LocalUsageVaultEntry
): Promise<LocalVaultUsage> {
  const components: LocalComponentUsage[] = [
    {
      component: "ledger",
      bytes: await fileBytes(entry.dir, LEDGER_FILES),
      files: null,
    },
    {
      component: "vault-db",
      bytes: await fileBytes(entry.dir, VAULT_DB_FILES),
      files: null,
    },
    await dirComponent("attachments", path.join(entry.dir, "blobs")),
    await dirComponent("apps", path.join(entry.dir, "apps")),
    await dirComponent("code", path.join(entry.dir, "code")),
  ];
  if (entry.cacheDir)
    components.push(await dirComponent("cache", entry.cacheDir));
  return {
    vaultId: entry.vaultId,
    ...(entry.name ? { name: entry.name } : {}),
    bytes: components.reduce((sum, c) => sum + c.bytes, 0),
    components,
  };
}

const defaultStatfs = (
  dir: string
): { bavail: number; bsize: number; blocks: number } | null => {
  try {
    return statfsSync(dir);
  } catch {
    return null;
  }
};

/**
 * The component walker with the stale-while-refresh cache described in the
 * module header. One instance per gateway; `report()` is what the route and
 * the `storage-limit` health probe both read, so they can never disagree.
 */
export class LocalUsageScanner {
  private readonly options: LocalUsageOptions;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly statfs: (
    dir: string
  ) => { bavail: number; bsize: number; blocks: number } | null;
  private cached: LocalUsageReport | null = null;
  private refreshing: Promise<LocalUsageReport> | null = null;

  constructor(options: LocalUsageOptions) {
    this.options = options;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.statfs = options.statfs ?? defaultStatfs;
  }

  /**
   * The cached report, refreshing in the background once stale. The first
   * call awaits a real walk; later calls resolve immediately.
   *
   * `force` re-walks inline — used by the route's explicit refresh, never by
   * a poll.
   */
  async report(opts: { force?: boolean } = {}): Promise<LocalUsageReport> {
    const cached = this.cached;
    if (!cached || opts.force) return this.refresh();
    if (this.now() - cached.scannedAt >= this.ttlMs && !this.refreshing) {
      // Detached: this read serves the stale report; the NEXT one picks up
      // the fresh figures. A rejection is already folded into the report's
      // `error` field by `refresh`, so nothing escapes here.
      void this.refresh().catch(() => {});
    }
    return cached;
  }

  /** Walks now, sharing one in-flight walk between concurrent callers. */
  private refresh(): Promise<LocalUsageReport> {
    const inFlight = this.refreshing;
    if (inFlight) return inFlight;
    const run = this.scan()
      .then((report) => {
        this.cached = report;
        return report;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        // Last-known-good beats a blank number; a fresh gateway with no cache
        // yet reports empty-but-explained rather than throwing at the route.
        const fallback: LocalUsageReport = this.cached
          ? { ...this.cached, error: message }
          : {
              scannedAt: this.now(),
              totalBytes: 0,
              components: [],
              vaults: [],
              disk: null,
              error: message,
            };
        this.cached = fallback;
        return fallback;
      })
      .finally(() => {
        this.refreshing = null;
      });
    this.refreshing = run;
    return run;
  }

  private async scan(): Promise<LocalUsageReport> {
    const vaults = await Promise.all(
      this.options.vaults().map((entry) => scanVault(entry))
    );

    const gatewayDirs = this.options.gatewayDirs();
    const components = await Promise.all(
      (
        Object.entries(gatewayDirs) as [LocalComponentId, string | undefined][]
      ).flatMap(([component, dir]) =>
        dir ? [dirComponent(component, dir)] : []
      )
    );

    const stat = this.statfs(this.options.rootDir);
    const vaultBytes = vaults.reduce((sum, v) => sum + v.bytes, 0);
    const gatewayBytes = components.reduce((sum, c) => sum + c.bytes, 0);
    return {
      scannedAt: this.now(),
      totalBytes: vaultBytes + gatewayBytes,
      components,
      vaults,
      disk: stat
        ? {
            freeBytes: stat.bavail * stat.bsize,
            totalBytes: stat.blocks * stat.bsize,
          }
        : null,
    };
  }
}
