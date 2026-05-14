import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface VersionRecord {
  versionId: string;
  /** sha256 over the uploaded tarball bytes. */
  sha256: string;
  /** Value of `app.json#version` at upload time, if any. */
  declaredVersion?: string;
  uploadedAt: string;
  bytes: number;
  files: number;
}

interface CurrentFile {
  activeVersion: string;
  history: VersionRecord[];
}

/**
 * Manages per-app `versions/` directories and `current.json`.
 *
 * Layout:
 *   <appsDir>/<id>/
 *     data.sqlite                   ← persistent, never moved
 *     current.json                  ← { activeVersion, history }
 *     versions/
 *       v_<UTC ts>_<sha[:6]>/       ← immutable
 *       v_...
 */
export class VersionStore {
  private async readCurrent(appDir: string): Promise<CurrentFile | undefined> {
    try {
      const raw = await fs.readFile(path.join(appDir, 'current.json'), 'utf8');
      const parsed = JSON.parse(raw) as CurrentFile;
      if (!parsed.activeVersion || !Array.isArray(parsed.history)) return undefined;
      return parsed;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return undefined;
    }
  }

  private async writeCurrent(appDir: string, data: CurrentFile): Promise<void> {
    const file = path.join(appDir, 'current.json');
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  async getActiveVersion(appDir: string): Promise<string | undefined> {
    const current = await this.readCurrent(appDir);
    return current?.activeVersion;
  }

  async listVersions(appDir: string): Promise<{
    activeVersion?: string;
    versions: VersionRecord[];
  }> {
    const current = await this.readCurrent(appDir);
    return {
      activeVersion: current?.activeVersion,
      versions: current?.history ?? [],
    };
  }

  /**
   * Promote an already-extracted version directory to the canonical location
   * and atomically swap `current.json`.
   *
   * `extractedDir` must be the absolute path of the new version contents.
   * The function moves it into `<appDir>/versions/<versionId>/`.
   */
  async commit(appDir: string, extractedDir: string, record: VersionRecord): Promise<void> {
    const versionsDir = path.join(appDir, 'versions');
    await fs.mkdir(versionsDir, { recursive: true });
    const target = path.join(versionsDir, record.versionId);

    // If a same-versionId dir already exists (re-upload of identical content),
    // remove the new extracted copy and reuse the existing one.
    try {
      await fs.access(target);
      await fs.rm(extractedDir, { recursive: true, force: true });
    } catch {
      await fs.rename(extractedDir, target);
    }

    const current = (await this.readCurrent(appDir)) ?? { activeVersion: '', history: [] };
    // Replace any prior history entry with the same versionId (idempotent re-upload).
    const filtered = current.history.filter((h) => h.versionId !== record.versionId);
    filtered.push(record);
    await this.writeCurrent(appDir, {
      activeVersion: record.versionId,
      history: filtered,
    });
  }

  /**
   * Atomically point `current.json#activeVersion` at `versionId`. Throws if the
   * version dir doesn't exist.
   */
  async activate(appDir: string, versionId: string): Promise<void> {
    const versionDir = path.join(appDir, 'versions', versionId);
    try {
      const stat = await fs.stat(versionDir);
      if (!stat.isDirectory())
        throw new VersionStoreError('not_found', `Version "${versionId}" not found.`);
    } catch {
      throw new VersionStoreError('not_found', `Version "${versionId}" not found.`);
    }
    const current = (await this.readCurrent(appDir)) ?? { activeVersion: '', history: [] };
    if (current.activeVersion === versionId) return;
    await this.writeCurrent(appDir, {
      activeVersion: versionId,
      history: current.history,
    });
  }

  /** Delete a single version dir. Refuses if it's the active one. */
  async deleteVersion(appDir: string, versionId: string): Promise<void> {
    const current = await this.readCurrent(appDir);
    if (current && current.activeVersion === versionId) {
      throw new VersionStoreError('active', `Cannot delete active version "${versionId}".`);
    }
    const versionDir = path.join(appDir, 'versions', versionId);
    await fs.rm(versionDir, { recursive: true, force: true });

    if (current) {
      await this.writeCurrent(appDir, {
        activeVersion: current.activeVersion,
        history: current.history.filter((h) => h.versionId !== versionId),
      });
    }
  }

  /**
   * Keep at most `retain` versions. Active version is always kept. Older
   * non-active versions are removed (oldest first).
   */
  async prune(appDir: string, retain: number): Promise<{ removed: string[] }> {
    const minRetain = Math.max(2, retain);
    const current = await this.readCurrent(appDir);
    if (!current) return { removed: [] };

    const sorted = [...current.history].sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));
    const active = current.activeVersion;
    const removed: string[] = [];

    while (sorted.length > minRetain) {
      const oldest = sorted[0];
      if (!oldest) break;
      if (oldest.versionId === active) {
        // Active is the oldest — skip it, look at next
        if (sorted.length <= minRetain) break;
        sorted.shift();
        continue;
      }
      sorted.shift();
      try {
        await fs.rm(path.join(appDir, 'versions', oldest.versionId), {
          recursive: true,
          force: true,
        });
        removed.push(oldest.versionId);
      } catch {
        /* best effort */
      }
    }

    if (removed.length > 0) {
      await this.writeCurrent(appDir, {
        activeVersion: current.activeVersion,
        history: current.history.filter((h) => !removed.includes(h.versionId)),
      });
    }
    return { removed };
  }

  /**
   * Recovery pass for `gateway_start`. If `current.json` is missing or refers
   * to a vanished version dir, falls back to the lexicographically newest
   * `versions/v_<...>` directory and rewrites `current.json`. No-op if
   * everything's fine.
   *
   * Returns `true` if anything was repaired.
   */
  async recover(appDir: string): Promise<boolean> {
    const versionsDir = path.join(appDir, 'versions');
    let entries: string[];
    try {
      entries = (await fs.readdir(versionsDir)).filter((n) => n.startsWith('v_'));
    } catch {
      return false; // No versions/ → not an uploaded app
    }
    if (entries.length === 0) return false;

    const current = await this.readCurrent(appDir);
    const activeStillThere = current?.activeVersion && entries.includes(current.activeVersion);
    if (current && activeStillThere) return false;

    entries.sort(); // lexicographic == chronological by our v_<ISO>_<hash> scheme
    const fallback = entries[entries.length - 1];
    if (!fallback) return false;
    await this.writeCurrent(appDir, {
      activeVersion: fallback,
      history: current?.history ?? [
        {
          versionId: fallback,
          sha256: '',
          uploadedAt: new Date().toISOString(),
          bytes: 0,
          files: 0,
        },
      ],
    });
    return true;
  }
}

// eslint-disable-next-line max-classes-per-file -- error class is colocated with its module
export class VersionStoreError extends Error {
  constructor(
    public readonly code: 'not_found' | 'active',
    message: string,
  ) {
    super(message);
    this.name = 'VersionStoreError';
  }
}
