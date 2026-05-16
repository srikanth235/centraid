import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppId, AppMode, RegistryEntry } from './types.js';
import { isReservedAppId } from './security.js';

/**
 * Persistent registry of registered apps stored at <appsDir>/_registry.json.
 */
/* eslint-disable max-classes-per-file -- error class is colocated with its module */
export class Registry {
  private cache = new Map<AppId, RegistryEntry>();
  private loaded = false;

  constructor(private readonly appsDir: string) {}

  private get filePath(): string {
    return path.join(this.appsDir, '_registry.json');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await fs.mkdir(this.appsDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as { apps: Array<RegistryEntry & { mode?: AppMode }> };
      // Backfill: older registry rows didn't have `mode`. Default to "path".
      this.cache = new Map(
        parsed.apps.map((a) => [
          a.id,
          { ...a, mode: a.mode ?? ('path' as const) } as RegistryEntry,
        ]),
      );
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.cache = new Map();
      await this.persist();
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const data = JSON.stringify({ apps: [...this.cache.values()] }, null, 2);
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, this.filePath);
  }

  list(): RegistryEntry[] {
    return [...this.cache.values()];
  }

  get(id: AppId): RegistryEntry | undefined {
    return this.cache.get(id);
  }

  async register(input: { id: AppId; path: string; mode?: AppMode }): Promise<RegistryEntry> {
    if (isReservedAppId(input.id)) {
      throw new RegistryError('invalid_id', `App id "${input.id}" is reserved or invalid.`);
    }
    if (this.cache.has(input.id)) {
      throw new RegistryError('already_registered', `App "${input.id}" is already registered.`);
    }

    const absPath = path.isAbsolute(input.path)
      ? input.path
      : path.resolve(this.appsDir, input.path);

    const stat = await fs.stat(absPath).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new RegistryError('not_a_directory', `App path "${absPath}" is not a directory.`);
    }

    const entry: RegistryEntry = {
      id: input.id,
      path: absPath,
      mode: input.mode ?? 'path',
      registeredAt: new Date().toISOString(),
    };
    this.cache.set(input.id, entry);
    await this.persist();
    return entry;
  }

  /**
   * Idempotent upsert used by the upload endpoint. Creates the app record if
   * missing (mode = "uploaded", path = `<appsDir>/<id>`) and creates the
   * directory on disk. Existing path-mode entries are refused with `already_registered`.
   */
  async ensureUploaded(id: AppId): Promise<RegistryEntry> {
    if (isReservedAppId(id)) {
      throw new RegistryError('invalid_id', `App id "${id}" is reserved or invalid.`);
    }
    const existing = this.cache.get(id);
    if (existing) {
      if (existing.mode !== 'uploaded') {
        throw new RegistryError(
          'already_registered',
          `App "${id}" was registered as a path-mode app; upload is only supported for uploaded-mode apps.`,
        );
      }
      return existing;
    }
    const dir = path.join(this.appsDir, id);
    await fs.mkdir(dir, { recursive: true });
    const entry: RegistryEntry = {
      id,
      path: dir,
      mode: 'uploaded',
      registeredAt: new Date().toISOString(),
    };
    this.cache.set(id, entry);
    await this.persist();
    return entry;
  }

  async deregister(id: AppId): Promise<RegistryEntry | undefined> {
    const entry = this.cache.get(id);
    if (!entry) return undefined;
    this.cache.delete(id);
    await this.persist();
    return entry;
  }
}

export class RegistryError extends Error {
  constructor(
    public readonly code: 'invalid_id' | 'already_registered' | 'not_a_directory',
    message: string,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}
