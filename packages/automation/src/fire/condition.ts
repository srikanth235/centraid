/**
 * Condition-trigger evaluation — the "time lives in the data" half of the
 * duaility trigger model.
 *
 * A condition trigger declares a consented vault read (`entity` + `where`);
 * the host evaluates it on the trigger's cron gate under the automation's
 * enrolled-agent grant, and fires the automation once per row it has not
 * seen before. Dedup is by row CONTENT: each matched row is hashed whole,
 * and the set of hashes currently matching is the cursor (persisted in the
 * automation's cross-run state under a reserved key). Consequences:
 *
 *   - a row that stays matched across evaluations fires exactly once;
 *   - a row that changes (an invoice reschedule bumps `sequence`, a renewal
 *     moves `due_at`) fires again — a changed row is a new event;
 *   - a row that leaves the window and later re-enters fires again, which is
 *     what a reminder wants.
 *
 * A receipted consent deny — or any bridge error — evaluates to "no fire"
 * with the reason surfaced; failure never widens access and never crashes
 * the scheduler tick.
 */

import { createHash } from 'node:crypto';
import { ConversationStore, makeJournalDbProvider, type VaultBridge } from '@centraid/app-engine';
import type { ConditionTrigger, DataTrigger } from '../manifest/manifest.js';
import { parseRef } from '../manifest/ref.js';
import type { CursorReadResult } from './cursor-engine.js';

/**
 * Reserved `automation_state` key prefix for trigger cursors. Handlers share
 * the same KV namespace via `ctx.state`; keys under this prefix belong to
 * the trigger machinery.
 */
export const TRIGGER_STATE_PREFIX = '__trigger:';

/** Cap on rows handed to one fire — a runaway match set becomes batches. */
const MAX_ROWS_PER_FIRE = 50;
/** Cap on remembered hashes — beyond this the oldest matches re-fire. */
const MAX_SEEN_HASHES = 2000;

export interface ConditionEvaluation {
  /** True when unseen rows matched — the host should fire the automation. */
  fire: boolean;
  /** The unseen rows (capped) — becomes the fire's `ctx.input.rows`. */
  rows: Record<string, unknown>[];
  /** Total rows currently matching, seen or not. */
  matched: number;
  /** Deny/error detail when the read could not run. `fire` is false. */
  reason?: string;
}

export interface EvaluateConditionOptions {
  /** `<appId>/<automationId>` handle owning the trigger. */
  automationRef: string;
  /** The condition trigger and its index in `manifest.triggers` (cursor identity). */
  trigger: ConditionTrigger;
  triggerIndex: number;
  /** DPV purpose the read declares — the manifest vault block's purpose. */
  purpose: string;
  /** The vault's `journal.db` — trigger cursors live in its automation KV (#280). */
  journalDbFile: string;
  /** The automation's agent-credentialed vault executor. */
  vault: VaultBridge;
}

// One store (→ one lazily-opened connection) per journal.db, for the
// scheduler's repeated evaluations — the app-engine doctrine is one
// connection per file, and a fresh provider per tick would leak handles.
// Bounded by the number of vaults evaluated on the host.
const storeByPath = new Map<string, ConversationStore>();

function storeFor(journalDbFile: string): ConversationStore {
  let store = storeByPath.get(journalDbFile);
  if (!store) {
    store = new ConversationStore(makeJournalDbProvider(journalDbFile));
    storeByPath.set(journalDbFile, store);
  }
  return store;
}

/** Parse one persisted trigger-cursor value; malformed state reads as absent. */
function readJsonState<T>(
  store: ConversationStore,
  automationRef: string,
  key: string,
  pick: (parsed: unknown) => T | undefined,
): T | undefined {
  const entry = store.stateGet(automationRef, key);
  if (!entry) return undefined;
  try {
    return pick(JSON.parse(entry.valueJson) as unknown);
  } catch {
    return undefined;
  }
}

function rowHash(row: Record<string, unknown>): string {
  const keys = Object.keys(row).sort();
  const canonical = JSON.stringify(keys.map((k) => [k, row[k]]));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/**
 * Run one condition trigger's consented read and diff it against the
 * persisted cursor. Persists the new cursor (all currently-matching hashes)
 * before returning, so a fire that later fails still won't re-fire on the
 * same unchanged rows — at-most-once per row content, by design: a reminder
 * that misfires once is recoverable, a reminder loop is spam.
 */
export async function evaluateConditionTrigger(
  opts: EvaluateConditionOptions,
): Promise<ConditionEvaluation> {
  const parsed = parseRef(opts.automationRef);
  if (!parsed) {
    return { fire: false, rows: [], matched: 0, reason: `invalid ref ${opts.automationRef}` };
  }
  const result = await opts.vault({
    op: 'read',
    payload: {
      entity: opts.trigger.entity,
      ...(opts.trigger.where ? { where: opts.trigger.where } : {}),
      purpose: opts.purpose,
      limit: 1000,
    },
  });
  if (!result.ok) {
    return {
      fire: false,
      rows: [],
      matched: 0,
      reason: `${result.code ?? 'VAULT_ERROR'}: ${result.error ?? 'vault read failed'}`,
    };
  }
  const rows = ((result.result as { rows?: Record<string, unknown>[] })?.rows ?? []).slice();

  const store = storeFor(opts.journalDbFile);
  const stateKey = `${TRIGGER_STATE_PREFIX}${opts.triggerIndex}:seen`;
  const seen =
    readJsonState(store, opts.automationRef, stateKey, (v) =>
      Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string') : undefined,
    ) ?? [];
  const seenSet = new Set(seen);
  const fresh: Record<string, unknown>[] = [];
  const current: string[] = [];
  for (const row of rows) {
    const hash = rowHash(row);
    current.push(hash);
    if (!seenSet.has(hash)) fresh.push(row);
  }
  // The cursor is the CURRENT match set: rows that left the window are
  // forgotten (re-entry re-fires), unchanged matches stay suppressed.
  store.stateSet(
    opts.automationRef,
    stateKey,
    JSON.stringify(current.slice(0, MAX_SEEN_HASHES)),
    Date.now(),
  );
  return {
    fire: fresh.length > 0,
    rows: fresh.slice(0, MAX_ROWS_PER_FIRE),
    matched: rows.length,
  };
}

export interface DataEvaluation {
  /** True when new change entries arrived — the host should fire. */
  fire: boolean;
  /** The new provenance entries (already capped by the feed). */
  changes: Record<string, unknown>[];
  /** Deny/error detail when the pull could not run. `fire` is false. */
  reason?: string;
}

export interface EvaluateDataOptions {
  automationRef: string;
  trigger: DataTrigger;
  triggerIndex: number;
  purpose: string;
  /** The vault's `journal.db` — the trigger cursor lives in its automation KV (#280). */
  journalDbFile: string;
  vault: VaultBridge;
}

/**
 * Pull the consented change feed for one data trigger and advance its
 * cursor. The cursor is the journal's strictly time-ordered prov id,
 * persisted beside the condition cursors under the reserved `__trigger:`
 * prefix; a missing cursor bootstraps at the current watermark WITHOUT
 * firing — a fresh watcher reacts to what happens next, not to history.
 * The cursor persists before the fire decision returns, so a fire that
 * later fails skips those entries rather than looping on them.
 */
export async function evaluateDataTrigger(opts: EvaluateDataOptions): Promise<DataEvaluation> {
  const parsed = parseRef(opts.automationRef);
  if (!parsed) {
    return { fire: false, changes: [], reason: `invalid ref ${opts.automationRef}` };
  }
  const store = storeFor(opts.journalDbFile);
  const stateKey = `${TRIGGER_STATE_PREFIX}${opts.triggerIndex}:cursor`;
  const cursor =
    readJsonState(store, opts.automationRef, stateKey, (v) =>
      typeof v === 'string' ? v : undefined,
    ) ?? null;
  const result = await opts.vault({
    op: 'changes',
    payload: {
      entities: [...opts.trigger.entities],
      purpose: opts.purpose,
      cursor,
      limit: 200,
    },
  });
  if (!result.ok) {
    return {
      fire: false,
      changes: [],
      reason: `${result.code ?? 'VAULT_ERROR'}: ${result.error ?? 'vault changes failed'}`,
    };
  }
  const feed = result.result as {
    changes?: Record<string, unknown>[];
    cursor?: string;
  };
  const changes = feed?.changes ?? [];
  if (typeof feed?.cursor === 'string') {
    store.stateSet(opts.automationRef, stateKey, JSON.stringify(feed.cursor), Date.now());
  }
  // The bootstrap pull (cursor was null) intentionally never fires.
  return { fire: cursor !== null && changes.length > 0, changes };
}

export interface ReadConditionCursorOptions {
  automationRef: string;
  trigger: ConditionTrigger;
  purpose: string;
  vault: VaultBridge;
  positionJson?: string;
  limit: number;
  now: Date;
}

function stringArrayPosition(positionJson: string | undefined): string[] {
  if (!positionJson) return [];
  try {
    const parsed = JSON.parse(positionJson) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Derived-query cursor source: content hashes are its ordered position set. */
export async function readConditionCursor(
  options: ReadConditionCursorOptions,
): Promise<CursorReadResult> {
  if (!parseRef(options.automationRef)) {
    throw new Error(`invalid ref ${options.automationRef}`);
  }
  const result = await options.vault({
    op: 'read',
    payload: {
      entity: options.trigger.entity,
      ...(options.trigger.where ? { where: options.trigger.where } : {}),
      purpose: options.purpose,
      limit: 1000,
    },
  });
  if (!result.ok) {
    throw new Error(`${result.code ?? 'VAULT_ERROR'}: ${result.error ?? 'vault read failed'}`);
  }
  const rows = ((result.result as { rows?: Record<string, unknown>[] })?.rows ?? []).slice();
  const seen = new Set(stringArrayPosition(options.positionJson));
  const current = rows.map(rowHash);
  const fresh = rows
    .map((row, index) => ({ row, hash: current[index]! }))
    .filter(({ hash }) => !seen.has(hash));
  const delivered = fresh.slice(0, options.limit);
  const deliveredHashes = new Set(delivered.map(({ hash }) => hash));
  // The committed position advances over DELIVERED rows only: a match beyond
  // the cap stays unseen and arrives on the next gate tick. Rows that left the
  // window are dropped from the set, which is what makes a re-entry fire again.
  const position = current.filter((hash) => seen.has(hash) || deliveredHashes.has(hash));
  const occurredAt = options.now.getTime();
  return {
    elements: delivered.map(({ row, hash }) => ({
      // One position per DELIVERY OCCURRENCE, not per row content. The host
      // derives its idempotency run id from this, so a row that leaves the
      // window and re-enters unchanged — the documented reminder behaviour —
      // must not collide with the run that fired the first time. Rows still
      // matching are suppressed by the hash set above, never by this id.
      position: `${hash}:${occurredAt}`,
      occurredAt,
      payload: row,
    })),
    positionJson: JSON.stringify(position.slice(0, MAX_SEEN_HASHES)),
    skipped: 0,
  };
}

export interface ReadDataCursorOptions {
  automationRef: string;
  trigger: DataTrigger;
  purpose: string;
  vault: VaultBridge;
  positionJson?: string;
  limit: number;
  now: Date;
}

function scalarPosition(positionJson: string | undefined): string | null {
  if (!positionJson) return null;
  try {
    const parsed = JSON.parse(positionJson) as unknown;
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** The feed-native watermark of one change entry, when it carries one. */
function changeId(change: Record<string, unknown>): string | undefined {
  for (const key of ['id', 'provId', 'provenanceId', 'cursor']) {
    const value = change[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function changePosition(change: Record<string, unknown>, index: number): string {
  return changeId(change) ?? `${rowHash(change)}:${index}`;
}

/** Vault provenance cursor source. Missing position bootstraps from now. */
export async function readDataCursor(options: ReadDataCursorOptions): Promise<CursorReadResult> {
  if (!parseRef(options.automationRef)) {
    throw new Error(`invalid ref ${options.automationRef}`);
  }
  const cursor = scalarPosition(options.positionJson);
  // Pull exactly what one fire may carry. The feed's returned watermark is the
  // last row it returned, so delivering the whole pull is the ONLY way the
  // committed position stays at a delivered element; over-pulling and slicing
  // would advance past entries no fire ever saw. A backlog beyond the cap is
  // still durably in the journal — the next gate tick reads it.
  const result = await options.vault({
    op: 'changes',
    payload: {
      entities: [...options.trigger.entities],
      purpose: options.purpose,
      cursor,
      limit: options.limit,
    },
  });
  if (!result.ok) {
    throw new Error(`${result.code ?? 'VAULT_ERROR'}: ${result.error ?? 'vault changes failed'}`);
  }
  const feed = result.result as {
    changes?: Record<string, unknown>[];
    cursor?: string;
  };
  const changes = feed.changes ?? [];
  // The bootstrap pull (no stored position) intentionally never fires: a fresh
  // watcher reacts to what happens next, not to the whole journal.
  const visible = cursor === null ? [] : changes;
  return {
    elements: visible.map((change, index) => {
      // Only a feed-native id is a legal watermark; a synthesized position
      // identifies the delivery but must never be committed as one.
      const watermark = changeId(change);
      return {
        position: changePosition(change, index),
        occurredAt: options.now.getTime(),
        payload: change,
        ...(watermark !== undefined ? { positionJson: JSON.stringify(watermark) } : {}),
      };
    }),
    ...(typeof feed.cursor === 'string' ? { positionJson: JSON.stringify(feed.cursor) } : {}),
    skipped: 0,
  };
}
