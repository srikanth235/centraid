import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppId, RegistryEntry } from '../types.js';
import { isReservedAppId } from '../http/security.js';

/**
 * Persistent registry of registered apps stored at `<appsDir>/_registry.json`.
 *
 * Every app is created via `ensureUploaded(id)` from the upload route —
 * there is no longer a way to register an external folder live. Older
 * rows carrying a `mode` field are loaded transparently and the field
 * is dropped on next persist.
 */
/* eslint-disable max-classes-per-file -- error class is colocated with its module (#247) */
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
      const parsed = JSON.parse(raw) as {
        apps: Array<{ id: string; path: string; registeredAt: string }>;
      };
      this.cache = new Map(
        parsed.apps.map((a) => [
          a.id,
          { id: a.id, path: a.path, registeredAt: a.registeredAt } as RegistryEntry,
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

  /**
   * Idempotent upsert used by the upload endpoint. Creates the app
   * record if missing (path = `<appsDir>/<id>`) and creates the
   * directory on disk. The only way to add an app to the registry.
   */
  async ensureUploaded(id: AppId): Promise<RegistryEntry> {
    if (isReservedAppId(id)) {
      throw new RegistryError('invalid_id', `App id "${id}" is reserved or invalid.`);
    }
    const existing = this.cache.get(id);
    if (existing) return existing;
    const dir = path.join(this.appsDir, id);
    await fs.mkdir(dir, { recursive: true });
    const entry: RegistryEntry = {
      id,
      path: dir,
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
    public readonly code: 'invalid_id' | 'already_registered',
    message: string,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}
