/*
 * AutomationStore — centraid's mirror of registered automations.
 *
 * The host scheduler (openclaw cron on remote, OS scheduler on local)
 * owns the schedule's runtime state (next-fire, last-fire, run log) —
 * this table is the canonical *registration* surface so the desktop UI
 * can list automations per app, the reconciliation pass at
 * `gateway_start` can diff DB-vs-host to clean up zombies, and an
 * editor session always has the user's NL prompt + manifest snapshot in
 * one place.
 *
 * See `automation-manifest.ts` for the manifest schema and `gateway-db.ts`
 * AUTOMATION_MIGRATIONS[0] for the table DDL. The mirror row is keyed by
 * (origin_app_id, name).
 */

import { type DatabaseSync, type StatementSync } from 'node:sqlite';
import type { DatabaseProvider } from './gateway-db.js';
import {
  AutomationManifestError,
  isValidAutomationName,
  parseManifest,
  type AutomationManifest,
} from './automation-manifest.js';

/** Row shape as it sits in the gateway DB. */
export interface AutomationRow {
  readonly originAppId: string;
  readonly name: string;
  readonly prompt: string;
  readonly cronExpr: string;
  readonly enabled: boolean;
  readonly manifest: AutomationManifest;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface RawRow {
  origin_app_id: string;
  name: string;
  prompt: string;
  cron_expr: string;
  enabled: number;
  manifest_json: string;
  created_at: number;
  updated_at: number;
}

interface PreparedStatements {
  upsert: StatementSync;
  getOne: StatementSync;
  listByApp: StatementSync;
  listAll: StatementSync;
  setEnabled: StatementSync;
  remove: StatementSync;
  removeByApp: StatementSync;
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
        `automations(${raw.origin_app_id}/${raw.name}): ${err.message}`,
      );
    }
    throw err;
  }
  return {
    originAppId: raw.origin_app_id,
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
      upsert: db.prepare(`
        INSERT INTO automations (origin_app_id, name, prompt, cron_expr, enabled, manifest_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(origin_app_id, name) DO UPDATE SET
          prompt = excluded.prompt,
          cron_expr = excluded.cron_expr,
          enabled = excluded.enabled,
          manifest_json = excluded.manifest_json,
          updated_at = excluded.updated_at
      `),
      getOne: db.prepare(`SELECT * FROM automations WHERE origin_app_id = ? AND name = ?`),
      listByApp: db.prepare(`SELECT * FROM automations WHERE origin_app_id = ? ORDER BY name`),
      listAll: db.prepare(`SELECT * FROM automations ORDER BY origin_app_id, name`),
      setEnabled: db.prepare(
        `UPDATE automations SET enabled = ?, updated_at = ? WHERE origin_app_id = ? AND name = ?`,
      ),
      remove: db.prepare(`DELETE FROM automations WHERE origin_app_id = ? AND name = ?`),
      removeByApp: db.prepare(`DELETE FROM automations WHERE origin_app_id = ?`),
    };
    this.db = db;
    this.stmts = stmts;
    return { db, stmts };
  }

  /**
   * Insert or update an automation row from a parsed manifest. Used by:
   *   - builder-harness when an automation is first scaffolded
   *   - re-prompting (the prompt + manifest snapshot get rewritten)
   *   - reconciliation when restoring from disk
   */
  upsert(appId: string, name: string, manifest: AutomationManifest, enabled = true): AutomationRow {
    if (!isValidAutomationName(name)) {
      throw new Error(`invalid automation name: ${name}`);
    }
    const { stmts } = this.ensureReady();
    const now = Date.now();
    stmts.upsert.run(
      appId,
      name,
      manifest.prompt,
      manifest.trigger.expr,
      enabled ? 1 : 0,
      JSON.stringify(manifest),
      now,
      now,
    );
    const row = stmts.getOne.get(appId, name) as RawRow | undefined;
    if (!row) throw new Error(`upsert succeeded but row not found for ${appId}/${name}`);
    return rowFromRaw(row);
  }

  get(appId: string, name: string): AutomationRow | undefined {
    const { stmts } = this.ensureReady();
    const row = stmts.getOne.get(appId, name) as RawRow | undefined;
    return row ? rowFromRaw(row) : undefined;
  }

  listByApp(appId: string): AutomationRow[] {
    const { stmts } = this.ensureReady();
    const rows = stmts.listByApp.all(appId) as unknown as RawRow[];
    return rows.map(rowFromRaw);
  }

  listAll(): AutomationRow[] {
    const { stmts } = this.ensureReady();
    const rows = stmts.listAll.all() as unknown as RawRow[];
    return rows.map(rowFromRaw);
  }

  setEnabled(appId: string, name: string, enabled: boolean): void {
    const { stmts } = this.ensureReady();
    stmts.setEnabled.run(enabled ? 1 : 0, Date.now(), appId, name);
  }

  remove(appId: string, name: string): void {
    const { stmts } = this.ensureReady();
    stmts.remove.run(appId, name);
  }

  /** Remove every automation belonging to an app. Used when an app is deregistered. */
  removeByApp(appId: string): void {
    const { stmts } = this.ensureReady();
    stmts.removeByApp.run(appId);
  }
}
