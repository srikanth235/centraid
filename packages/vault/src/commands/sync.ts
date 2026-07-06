// The agent-facing staging commands (issue #290 phase 3) — how interactive
// one-shot pulls write. An agent with a live harness session (MCP reach)
// parses whatever it pulled and STAGES it through `sync.stage_rows` (risk
// low: the staging band holds reviewable state, no domain table moves);
// landing it is `sync.publish_batch` (risk high: above every agent's
// ceiling, so it PARKS for the owner in the existing approval surface).
// The risk asymmetry IS the consent story — agents stage freely, the owner
// publishes deliberately. Credentials stay harness-ambient; the vault only
// ever sees parsed rows.

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';
import { PUBLISHERS } from '../ingest/publishers.js';
import {
  applyBatchTx,
  ensureConnectionTx,
  stageBatchTx,
  type StageCandidate,
} from '../ingest/staging.js';
import { sealedColumnsOf } from '../schema/sealed.js';

/** Bound one call's staging payload — bulk arrives as several batches. */
const MAX_ROWS_PER_STAGE = 500;

const STAGE_ROWS: CommandDefinition = {
  name: 'sync.stage_rows',
  ownerSchema: 'sync',
  inputSchema: {
    type: 'object',
    required: ['kind', 'label', 'rows'],
    additionalProperties: false,
    properties: {
      // e.g. `pull.gmail`, `pull.gcal` — names the SOURCE the agent read.
      kind: { type: 'string', minLength: 1 },
      label: { type: 'string', minLength: 1 },
      rows: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_ROWS_PER_STAGE,
        items: {
          type: 'object',
          required: ['entity_type', 'external_id', 'payload'],
          additionalProperties: false,
          properties: {
            entity_type: { type: 'string', minLength: 1 },
            external_id: { type: 'string', minLength: 1 },
            payload: { type: 'object' },
          },
        },
      },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['batch_id', 'connection_id'],
    properties: {
      batch_id: { type: 'string' },
      connection_id: { type: 'string' },
      staged: { type: 'object' },
      published: { type: 'object' },
    },
  },
  preconditions: [],
  postconditions: [
    {
      // Draft for review, or already applied under the connection's
      // owner-set `auto-publish` trust (issue #299 §3) — never discarded.
      name: 'batch_staged_or_auto_published',
      sql: `SELECT count(*) AS n FROM sync_import_batch WHERE batch_id = :batch_id AND status IN ('draft','published')`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: stageRows,
};

function stageRows(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    kind: string;
    label: string;
    rows: { entity_type: string; external_id: string; payload: Record<string, unknown> }[];
  };
  // Only entity types with a publisher can ever land — refuse at staging
  // time, not at the owner's publish click.
  for (const row of input.rows) {
    if (!PUBLISHERS.has(row.entity_type)) {
      throw new Error(
        `no publisher for "${row.entity_type}" — stageable: ${[...PUBLISHERS.keys()].join(', ')}`,
      );
    }
    // Sealed entity types stage only through the owner's file-drop surface
    // (issue #293): an agent never carries secret material, even staged.
    if (sealedColumnsOf(row.entity_type).length > 0) {
      throw new Error(
        `"${row.entity_type}" carries sealed columns — secret material stages only through the owner's import surface (issue #293)`,
      );
    }
  }
  const connectionId = ensureConnectionTx(ctx.db, { kind: input.kind, label: input.label });
  // Attribution is injected server-side, never trusted from source data
  // (issue #299 §1): an annotation candidate is stamped with the CALLER's
  // party — the enricher's enrolled agent party, or the owner running an
  // import by hand. Masquerade is structurally impossible.
  const authorPartyId = ctx.identity.partyId ?? ownerPartyIdOf(ctx);
  const candidates: StageCandidate[] = input.rows.map((r) => ({
    entityType: r.entity_type,
    externalId: r.external_id,
    payload:
      r.entity_type === 'knowledge.annotation'
        ? { ...r.payload, author_party_id: authorPartyId }
        : r.payload,
  }));
  const { batchId, counts } = stageBatchTx(ctx.db, connectionId, candidates, PUBLISHERS, ctx.now);
  ctx.wrote('sync.import_batch', batchId);
  // The owner's standing consent (issue #299 §3): a connection the owner set
  // to `auto-publish` applies its batch in the same command — captions and
  // machine tags land without a review click, still receipted, still
  // provenance-stamped per row. `staged` trust keeps today's behavior.
  const trust = (
    ctx.db.prepare('SELECT trust FROM sync_connection WHERE connection_id = ?').get(connectionId) as
      | { trust: string }
      | undefined
  )?.trust;
  if (trust === 'auto-publish') {
    const applied = applyBatchTx(ctx.db, batchId, PUBLISHERS, ownerPartyIdOf(ctx), ctx.now);
    for (const write of applied.provenanced) ctx.wrote(write.type, write.id);
    ctx.cite({
      claim: `auto-published ${applied.created + applied.updated} row(s) from ${input.kind} "${input.label}" under the connection's standing trust (${applied.failed.length} failed)`,
      entityType: 'sync.import_batch',
      entityId: batchId,
    });
    return {
      batch_id: batchId,
      connection_id: connectionId,
      staged: counts,
      published: {
        created: applied.created,
        updated: applied.updated,
        skipped: applied.skipped,
        failed: applied.failed.length,
      },
    };
  }
  ctx.cite({
    claim: `staged ${input.rows.length} row(s) from ${input.kind} "${input.label}" as draft ${batchId} (${counts.create} create, ${counts.update} update, ${counts.skip} skip)`,
    entityType: 'sync.import_batch',
    entityId: batchId,
  });
  return { batch_id: batchId, connection_id: connectionId, staged: counts };
}

/** The vault owner's party id — the publish actor for auto-publish trust. */
function ownerPartyIdOf(ctx: HandlerCtx): string {
  const owner = ctx.db.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get() as
    | { owner_party_id: string | null }
    | undefined;
  if (!owner?.owner_party_id) throw new Error('vault has no owner');
  return owner.owner_party_id;
}

const PUBLISH_BATCH: CommandDefinition = {
  name: 'sync.publish_batch',
  ownerSchema: 'sync',
  inputSchema: {
    type: 'object',
    required: ['batch_id'],
    additionalProperties: false,
    properties: { batch_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['batch_id', 'created', 'updated', 'skipped'],
    properties: {
      batch_id: { type: 'string' },
      created: { type: 'integer' },
      updated: { type: 'integer' },
      skipped: { type: 'integer' },
      failed: { type: 'integer' },
    },
  },
  preconditions: [
    {
      name: 'batch_is_a_draft',
      sql: `SELECT count(*) AS n FROM sync_import_batch WHERE batch_id = :batch_id AND status = 'draft'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'batch_published',
      sql: `SELECT count(*) AS n FROM sync_import_batch WHERE batch_id = :batch_id AND status = 'published'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  // Above every agent ceiling — an agent-proposed publish PARKS for the
  // owner; the pause between draft and send is the consent gesture.
  risk: 'high',
  handler: publishStagedBatch,
};

function publishStagedBatch(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { batch_id: string };
  const owner = ctx.db.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get() as
    | { owner_party_id: string | null }
    | undefined;
  if (!owner?.owner_party_id) throw new Error('vault has no owner');
  const applied = applyBatchTx(ctx.db, input.batch_id, PUBLISHERS, owner.owner_party_id, ctx.now);
  // Published rows ride the command pipeline's evidence: provenance names
  // this invocation (data triggers see real imports and may react).
  for (const write of applied.provenanced) ctx.wrote(write.type, write.id);
  ctx.wrote('sync.import_batch', input.batch_id);
  ctx.cite({
    claim: `published batch ${input.batch_id} from ${applied.kind}: ${applied.created} created, ${applied.updated} updated, ${applied.skipped} skipped, ${applied.failed.length} failed`,
    entityType: 'sync.import_batch',
    entityId: input.batch_id,
  });
  return {
    batch_id: input.batch_id,
    created: applied.created,
    updated: applied.updated,
    skipped: applied.skipped,
    failed: applied.failed.length,
  };
}

// ── Connection lifecycle (issue #290 phase 4) ───────────────────────────
// A connector's run brackets: `sync.begin_run` is the principal-pinning
// hard gate (invariant 2 — the vault-side half of "verify the account
// before writing a row"), `sync.finish_run` closes the run log and flips
// health states, `sync.set_cursor` persists incremental position as
// receipted vault rows. Health is READABLE state (`sync.connection`,
// `sync.connection_run`) — sync never dies silently.

const BEGIN_RUN: CommandDefinition = {
  name: 'sync.begin_run',
  ownerSchema: 'sync',
  inputSchema: {
    type: 'object',
    required: ['kind', 'label'],
    additionalProperties: false,
    properties: {
      kind: { type: 'string', minLength: 1 },
      label: { type: 'string', minLength: 1 },
      /** The OBSERVED authenticated account (the connector's whoami probe). */
      principal: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['connection_id'],
    properties: {
      connection_id: { type: 'string' },
      run_id: { type: 'string' },
      cursors: { type: 'object' },
      // A refusal is an OUTPUT, not a thrown rollback — the needs-auth
      // flip must survive the invocation (a throw would undo it).
      refused: { type: 'string', enum: ['paused', 'principal-required', 'principal-mismatch'] },
      reason: { type: 'string' },
    },
  },
  preconditions: [],
  postconditions: [],
  idempotency: 'once',
  risk: 'low',
  handler: beginRun,
};

function beginRun(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { kind: string; label: string; principal?: string };
  const connectionId = ensureConnectionTx(ctx.db, { kind: input.kind, label: input.label });
  const connection = ctx.db
    .prepare('SELECT principal, status FROM sync_connection WHERE connection_id = ?')
    .get(connectionId) as { principal: string | null; status: string };

  // Paused means paused — the owner's stop is absolute until they resume.
  if (connection.status === 'paused') {
    return {
      connection_id: connectionId,
      refused: 'paused',
      reason: `connection "${input.label}" is paused by the owner`,
    };
  }
  // Principal pinning: the first observed principal pins; every later run
  // must match or the connection flips to needs-auth and the run refuses —
  // a work vault must never silently sync from a personal account. The
  // refusal is an output, not a throw: the health flip must COMMIT.
  if (connection.principal === null && input.principal) {
    ctx.db
      .prepare('UPDATE sync_connection SET principal = ? WHERE connection_id = ?')
      .run(input.principal, connectionId);
  } else if (connection.principal !== null) {
    if (!input.principal) {
      ctx.db
        .prepare(`UPDATE sync_connection SET status = 'needs-auth' WHERE connection_id = ?`)
        .run(connectionId);
      ctx.wrote('sync.connection', connectionId);
      return {
        connection_id: connectionId,
        refused: 'principal-required',
        reason: `connection "${input.label}" pins principal "${connection.principal}" — begin_run must carry the observed principal`,
      };
    }
    if (input.principal !== connection.principal) {
      ctx.db
        .prepare(`UPDATE sync_connection SET status = 'needs-auth' WHERE connection_id = ?`)
        .run(connectionId);
      ctx.wrote('sync.connection', connectionId);
      return {
        connection_id: connectionId,
        refused: 'principal-mismatch',
        reason: `connection "${input.label}" pins "${connection.principal}" but the harness is authenticated as "${input.principal}"`,
      };
    }
  }
  // A matching (or first) principal proves reach — the connection is live
  // again even if a previous run left it failing/needs-auth.
  ctx.db
    .prepare(`UPDATE sync_connection SET status = 'active' WHERE connection_id = ?`)
    .run(connectionId);
  const runId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO sync_connection_run (run_id, connection_id, started_at, finished_at, status, staged, published, skipped, error)
       VALUES (?, ?, ?, NULL, 'running', 0, 0, 0, NULL)`,
    )
    .run(runId, connectionId, ctx.now);
  ctx.wrote('sync.connection', connectionId);
  ctx.wrote('sync.connection_run', runId);
  const cursors = Object.fromEntries(
    (
      ctx.db
        .prepare('SELECT key, value_json FROM sync_connection_cursor WHERE connection_id = ?')
        .all(connectionId) as { key: string; value_json: string }[]
    ).map((r) => [r.key, JSON.parse(r.value_json) as unknown]),
  );
  return { connection_id: connectionId, run_id: runId, cursors };
}

const FINISH_RUN: CommandDefinition = {
  name: 'sync.finish_run',
  ownerSchema: 'sync',
  inputSchema: {
    type: 'object',
    required: ['run_id', 'ok'],
    additionalProperties: false,
    properties: {
      run_id: { type: 'string', minLength: 1 },
      ok: { type: 'boolean' },
      staged: { type: 'integer', minimum: 0 },
      published: { type: 'integer', minimum: 0 },
      skipped: { type: 'integer', minimum: 0 },
      error: { type: 'string' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['run_id'],
    properties: { run_id: { type: 'string' }, connection_status: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'run_is_open',
      sql: `SELECT count(*) AS n FROM sync_connection_run WHERE run_id = :run_id AND status = 'running'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'run_closed',
      sql: `SELECT count(*) AS n FROM sync_connection_run WHERE run_id = :run_id AND status != 'running'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: finishRun,
};

function finishRun(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    run_id: string;
    ok: boolean;
    staged?: number;
    published?: number;
    skipped?: number;
    error?: string;
  };
  const run = ctx.db
    .prepare('SELECT connection_id FROM sync_connection_run WHERE run_id = ?')
    .get(input.run_id) as { connection_id: string };
  ctx.db
    .prepare(
      `UPDATE sync_connection_run SET finished_at = ?, status = ?, staged = ?, published = ?, skipped = ?, error = ? WHERE run_id = ?`,
    )
    .run(
      ctx.now,
      input.ok ? 'ok' : 'failed',
      input.staged ?? 0,
      input.published ?? 0,
      input.skipped ?? 0,
      input.error ?? null,
      input.run_id,
    );
  // A failed run flips health to failing (visible, never silent); a good
  // one records freshness. needs-auth set by a mismatch stays sticky.
  const status = input.ok ? 'active' : 'failing';
  ctx.db
    .prepare(
      `UPDATE sync_connection SET last_run_at = ?, status = CASE WHEN status = 'needs-auth' THEN status ELSE ? END
        WHERE connection_id = ?`,
    )
    .run(ctx.now, status, run.connection_id);
  ctx.wrote('sync.connection_run', input.run_id);
  ctx.wrote('sync.connection', run.connection_id);
  ctx.cite({
    claim: `run ${input.run_id} finished ${input.ok ? 'ok' : `failed: ${input.error ?? 'unknown'}`} (staged ${input.staged ?? 0}, published ${input.published ?? 0}, skipped ${input.skipped ?? 0})`,
    entityType: 'sync.connection_run',
    entityId: input.run_id,
  });
  return { run_id: input.run_id, connection_status: input.ok ? 'active' : status };
}

const SET_CURSOR: CommandDefinition = {
  name: 'sync.set_cursor',
  ownerSchema: 'sync',
  inputSchema: {
    type: 'object',
    required: ['connection_id', 'key', 'value'],
    additionalProperties: false,
    properties: {
      connection_id: { type: 'string', minLength: 1 },
      key: { type: 'string', minLength: 1 },
      value: {},
    },
  },
  outputSchema: {
    type: 'object',
    required: ['connection_id', 'key'],
    properties: { connection_id: { type: 'string' }, key: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'connection_exists',
      sql: `SELECT count(*) AS n FROM sync_connection WHERE connection_id = :connection_id`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [],
  idempotency: 'idempotent',
  risk: 'low',
  handler: setCursor,
};

function setCursor(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { connection_id: string; key: string; value: unknown };
  const existing = ctx.db
    .prepare('SELECT cursor_id FROM sync_connection_cursor WHERE connection_id = ? AND key = ?')
    .get(input.connection_id, input.key) as { cursor_id: string } | undefined;
  const cursorId = existing?.cursor_id ?? ctx.newId();
  if (existing) {
    ctx.db
      .prepare(
        'UPDATE sync_connection_cursor SET value_json = ?, updated_at = ? WHERE cursor_id = ?',
      )
      .run(JSON.stringify(input.value ?? null), ctx.now, cursorId);
  } else {
    ctx.db
      .prepare(
        `INSERT INTO sync_connection_cursor (cursor_id, connection_id, key, value_json, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(cursorId, input.connection_id, input.key, JSON.stringify(input.value ?? null), ctx.now);
  }
  ctx.wrote('sync.connection_cursor', cursorId);
  return { connection_id: input.connection_id, key: input.key };
}

const SET_CONNECTION_STATUS: CommandDefinition = {
  name: 'sync.set_connection_status',
  ownerSchema: 'sync',
  inputSchema: {
    type: 'object',
    required: ['connection_id', 'status'],
    additionalProperties: false,
    properties: {
      connection_id: { type: 'string', minLength: 1 },
      // The owner's two levers: pause a connector, or resume one (a resumed
      // needs-auth connection re-proves itself on the next begin_run).
      // `needs-auth` is the fire path's flip when a declared secret item is
      // missing or trashed (issue #293) — same honest-liveness state a
      // principal mismatch shows.
      status: { type: 'string', enum: ['paused', 'active', 'needs-auth'] },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['connection_id', 'status'],
    properties: { connection_id: { type: 'string' }, status: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'connection_exists',
      sql: `SELECT count(*) AS n FROM sync_connection WHERE connection_id = :connection_id`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'status_applied',
      sql: `SELECT count(*) AS n FROM sync_connection WHERE connection_id = :connection_id AND status = :status`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  // Pausing/resuming a sync is an owner-consequence act: agents proposing
  // it park for confirmation.
  risk: 'medium',
  handler: setConnectionStatus,
};

function setConnectionStatus(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { connection_id: string; status: string };
  ctx.db
    .prepare('UPDATE sync_connection SET status = ? WHERE connection_id = ?')
    .run(input.status, input.connection_id);
  ctx.wrote('sync.connection', input.connection_id);
  return { connection_id: input.connection_id, status: input.status };
}

/** Register the staging + connection-lifecycle commands on a gateway. */
export function registerSyncCommands(gateway: Gateway): void {
  gateway.registerCommand(STAGE_ROWS);
  gateway.registerCommand(PUBLISH_BATCH);
  gateway.registerCommand(BEGIN_RUN);
  gateway.registerCommand(FINISH_RUN);
  gateway.registerCommand(SET_CURSOR);
  gateway.registerCommand(SET_CONNECTION_STATUS);
}
