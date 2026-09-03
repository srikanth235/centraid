import { promises as fs, statfsSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";

export type LocalComponentId =
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
  files: number | null;
  unreadable?: string;
}

export interface LocalVaultUsage {
  vaultId: string;
  name?: string;
  bytes: number;
  components: LocalComponentUsage[];
}

export interface LocalUsageReport {
  scannedAt: number;
  totalBytes: number;
  components: LocalComponentUsage[];
  vaults: LocalVaultUsage[];
  disk: { freeBytes: number; totalBytes: number } | null;
  error?: string;
}

const DEFAULT_TTL_MS = 60_000;

export interface LocalUsageVaultEntry {
  vaultId: string;
  name?: string;
  dir: string;
  cacheDir?: string;
}

export interface LocalUsageOptions {
  rootDir: string;
  vaults: () => LocalUsageVaultEntry[];
  gatewayDirs: () => Partial<Record<LocalComponentId, string | undefined>>;
  ttlMs?: number;
  now?: () => number;
  statfs?: (
    dir: string
  ) => { bavail: number; bsize: number; blocks: number } | null;
}

export async function walkDirBytes(
  dir: string
): Promise<{ bytes: number; files: number; unreadable?: string }> {
  let bytes = 0;
  let files = 0;
  let unreadable: string | undefined;
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

  async report(opts: { force?: boolean } = {}): Promise<LocalUsageReport> {
    const cached = this.cached;
    if (!cached || opts.force) return this.refresh();
    if (this.now() - cached.scannedAt >= this.ttlMs && !this.refreshing) {
      void this.refresh().catch(() => {});
    }
    return cached;
  }

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
