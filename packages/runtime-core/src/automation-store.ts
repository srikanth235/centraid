/*
 * AutomationStore — centraid's store of user-owned automations.
 *
 * Model-B (issue #90): an automation is owned by a user and identified
 * by a UUID `id`, not by the app it was authored from. `name` is unique
 * per user. The host scheduler (openclaw cron on remote, OS scheduler on
 * local) owns the schedule's runtime state (next-fire, last-fire) — this
 * table is the canonical definition so the desktop UI can list a user's
 * automations, the reconciliation pass at `gateway_start` can diff
 * DB-vs-host to clean up zombies, and an editor session always has the
 * NL prompt + manifest snapshot in one place.
 *
 * See `automation-manifest.ts` for the manifest schema and `gateway-db.ts`
 * ACTIVITY_MIGRATIONS[0] for the table DDL.
 */

import { randomUUID } from 'node:crypto';
import { type DatabaseSync, type StatementSync } from 'node:sqlite';
import type { DatabaseProvider } from './gateway-db.js';
import {
  AutomationManifestError,
  isValidAutomationName,
  parseManifest,
  type AutomationManifest,
} from './automation-manifest.js';

/** Row shape as it sits in the activity DB. */
export interface AutomationRow {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly prompt: string;
  readonly cronExpr: string;
  readonly enabled: boolean;
  readonly manifest: AutomationManifest;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface RawRow {
  id: string;
  user_id: string;
  name: string;
  prompt: string;
  cron_expr: string;
  enabled: number;
  manifest_json: string;
  created_at: number;
  updated_at: number;
}

interface PreparedStatements {
  insert: StatementSync;
  update: StatementSync;
  getById: StatementSync;
  getByName: StatementSync;
  listByUser: StatementSync;
  listAll: StatementSync;
  setEnabled: StatementSync;
  remove: StatementSync;
  removeByUser: StatementSync;
}

function rowFromRaw(raw: RawRow): AutomationRow {
  // Parsing the manifest on read keeps the row's `manifest` field strongly
  // typed for callers. Bad JSON in the DB is exceptional (we only write
  // validated manifests) but we surface a clear error rather than letting
  // a JSON.parse exception propagate from a SQL-shaped call site.
  let manifest: AutomationManifest;
  try {
    manifest = parseManifest(raw.manifest_json);
  } catch (err) {
    if (err instanceof AutomationManifestError) {
      throw new AutomationManifestError(
        err.code,
        `automations(${raw.id}/${raw.name}): ${err.message}`,
      );
    }
    throw err;
  }
  return {
    id: raw.id,
    userId: raw.user_id,
    name: raw.name,
    prompt: raw.prompt,
    cronExpr: raw.cron_expr,
    enabled: raw.enabled !== 0,
    manifest,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export class AutomationStore {
  private readonly dbProvider: DatabaseProvider;
  private db: DatabaseSync | undefined;
  private stmts: PreparedStatements | undefined;

  constructor(dbProvider: DatabaseProvider) {
    this.dbProvider = dbProvider;
  }

  private ensureReady(): { db: DatabaseSync; stmts: PreparedStatements } {
    if (this.db && this.stmts) return { db: this.db, stmts: this.stmts };
    const db = this.dbProvider();
    const stmts: PreparedStatements = {
      insert: db.prepare(`
        INSERT INTO automations (id, user_id, name, prompt, cron_expr, enabled, manifest_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      update: db.prepare(`
        UPDATE automations SET
          name = ?, prompt = ?, cron_expr = ?, enabled = ?, manifest_json = ?, updated_at = ?
        WHERE id = ?
      `),
      getById: db.prepare(`SELECT * FROM automations WHERE id = ?`),
      getByName: db.prepare(`SELECT * FROM automations WHERE user_id = ? AND name = ?`),
      listByUser: db.prepare(`SELECT * FROM automations WHERE user_id = ? ORDER BY name`),
      listAll: db.prepare(`SELECT * FROM automations ORDER BY user_id, name`),
      setEnabled: db.prepare(`UPDATE automations SET enabled = ?, updated_at = ? WHERE id = ?`),
      remove: db.prepare(`DELETE FROM automations WHERE id = ?`),
      removeByUser: db.prepare(`DELETE FROM automations WHERE user_id = ?`),
    };
    this.db = db;
    this.stmts = stmts;
    return { db, stmts };
  }

  /**
   * Insert a new automation, assigning a UUID. Throws if `(userId, name)`
   * already exists — callers that want create-or-update semantics use
   * {@link upsert}.
   */
  create(
    userId: string,
    name: string,
    manifest: AutomationManifest,
    enabled = true,
  ): AutomationRow {
    if (!isValidAutomationName(name)) {
      throw new Error(`invalid automation name: ${name}`);
    }
    const { stmts } = this.ensureReady();
    const id = randomUUID();
    const now = Date.now();
    stmts.insert.run(
      id,
      userId,
      name,
      manifest.prompt,
      manifest.trigger.expr,
      enabled ? 1 : 0,
      JSON.stringify(manifest),
      now,
      now,
    );
    const row = stmts.getById.get(id) as RawRow | undefined;
    if (!row) throw new Error(`insert succeeded but row not found for ${id}`);
    return rowFromRaw(row);
  }

  /**
   * Create-or-update by `(userId, name)`. Used by the manifest-sync
   * deploy boundary: a manifest file keeps its name across republishes,
   * so an existing row is updated in place (preserving its UUID + the
   * user's enabled toggle) and a new name gets a fresh UUID.
   */
  upsert(
    userId: string,
    name: string,
    manifest: AutomationManifest,
    enabled = true,
  ): AutomationRow {
    const existing = this.getByName(userId, name);
    if (!existing) return this.create(userId, name, manifest, enabled);
    const { stmts } = this.ensureReady();
    stmts.update.run(
      name,
      manifest.prompt,
      manifest.trigger.expr,
      enabled ? 1 : 0,
      JSON.stringify(manifest),
      Date.now(),
      existing.id,
    );
    const row = stmts.getById.get(existing.id) as RawRow | undefined;
    if (!row) throw new Error(`upsert succeeded but row not found for ${existing.id}`);
    return rowFromRaw(row);
  }

  get(id: string): AutomationRow | undefined {
    const { stmts } = this.ensureReady();
    const row = stmts.getById.get(id) as RawRow | undefined;
    return row ? rowFromRaw(row) : undefined;
  }

  getByName(userId: string, name: string): AutomationRow | undefined {
    const { stmts } = this.ensureReady();
    const row = stmts.getByName.get(userId, name) as RawRow | undefined;
    return row ? rowFromRaw(row) : undefined;
  }

  listByUser(userId: string): AutomationRow[] {
    const { stmts } = this.ensureReady();
    const rows = stmts.listByUser.all(userId) as unknown as RawRow[];
    return rows.map(rowFromRaw);
  }

  listAll(): AutomationRow[] {
    const { stmts } = this.ensureReady();
    const rows = stmts.listAll.all() as unknown as RawRow[];
    return rows.map(rowFromRaw);
  }

  setEnabled(id: string, enabled: boolean): void {
    const { stmts } = this.ensureReady();
    stmts.setEnabled.run(enabled ? 1 : 0, Date.now(), id);
  }

  remove(id: string): void {
    const { stmts } = this.ensureReady();
    stmts.remove.run(id);
  }

  /** Remove every automation owned by a user. Used when a user is deleted. */
  removeByUser(userId: string): void {
    const { stmts } = this.ensureReady();
    stmts.removeByUser.run(userId);
  }
}
