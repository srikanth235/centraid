// governance: allow-repo-hygiene file-size-limit the staging commands and the broker-credential lifecycle commands (#304) are one sync vocabulary — begin/finish/cursor/status and configure/store share the connection state machine, so splitting scatters the invariants
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

/**
 * Derived-data class per stageable entity type (issue #310 C3) — the unit
 * the owner consents to when narrowing a connection's auto-publish trust.
 * Entity types not named here (plain import types: events, transactions,
 * contacts…) are untouched by class narrowing.
 */
const ENRICH_CLASS_OF: Readonly<Record<string, string>> = {
  'knowledge.annotation': 'caption',
  'core.tag': 'tag',
  'media.face_region': 'face',
  'core.collection': 'collection',
  'core.content_item': 'filing',
};
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
  // The owner's standing consent (issue #299 §3): a connection the owner set
  // to `auto-publish` applies its batch in the same command — captions and
  // machine tags land without a review click, still receipted, still
  // provenance-stamped per row. `staged` trust keeps today's behavior.
  //
  // Per-class narrowing (issue #310 C3): the owner may have consented to
  // captions but not face suggestions. Candidates in classes OUTSIDE the
  // connection's enrich_classes_json auto-publish nothing — they stage as a
  // separate draft batch for review, never silently dropped and never
  // silently landed.
  const conn = ctx.db
    .prepare('SELECT trust, enrich_classes_json FROM sync_connection WHERE connection_id = ?')
    .get(connectionId) as { trust: string; enrich_classes_json: string | null } | undefined;
  if (conn?.trust === 'auto-publish') {
    const allowed = conn.enrich_classes_json
      ? new Set(JSON.parse(conn.enrich_classes_json) as string[])
      : null;
    const auto: StageCandidate[] = [];
    const held: StageCandidate[] = [];
    for (const c of candidates) {
      const cls = ENRICH_CLASS_OF[c.entityType];
      if (allowed === null || (cls !== undefined && allowed.has(cls))) auto.push(c);
      else held.push(c);
    }
    let heldBatchId: string | null = null;
    if (held.length > 0) {
      const heldStage = stageBatchTx(ctx.db, connectionId, held, PUBLISHERS, ctx.now);
      heldBatchId = heldStage.batchId;
      ctx.wrote('sync.import_batch', heldBatchId);
      ctx.cite({
        claim: `${held.length} row(s) in classes outside the connection's standing consent staged as draft ${heldBatchId} for review`,
        entityType: 'sync.import_batch',
        entityId: heldBatchId,
      });
    }
    const { batchId, counts } = stageBatchTx(ctx.db, connectionId, auto, PUBLISHERS, ctx.now);
    ctx.wrote('sync.import_batch', batchId);
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
      ...(heldBatchId ? { held_batch_id: heldBatchId, held: held.length } : {}),
    };
  }
  const { batchId, counts } = stageBatchTx(ctx.db, connectionId, candidates, PUBLISHERS, ctx.now);
  ctx.wrote('sync.import_batch', batchId);
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
  // An agent-proposed publish PARKS for the owner (issue #306 Tier 4): a
  // whole batch landing in domain tables bypasses the staged-trust review,
  // so the pause between draft and land stays the consent gesture.
  risk: 'high',
  confirm: true,
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
      // WHY the connection left active (issue #304): "refresh refused",
      // "scope withdrawn"… — what the reconnect surface shows the owner.
      note: { type: 'string', minLength: 1 },
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
  // Deliberately NOT confirm-gated (issue #308 A2 sweep): the fire path's
  // needs-auth honesty flip rides the agent plane and must land unparked,
  // and no status value moves credentials or hosts. Risk medium keeps the
  // act salient in the review feed.
  risk: 'medium',
  handler: setConnectionStatus,
};

function setConnectionStatus(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { connection_id: string; status: string; note?: string };
  ctx.db
    .prepare('UPDATE sync_connection SET status = ? WHERE connection_id = ?')
    .run(input.status, input.connection_id);
  // A connection back in `active` carries no stale complaint; a flip away
  // from it records why, so the reconnect surface is actionable. A note-less
  // non-active flip keeps whatever complaint is already there.
  if (input.status === 'active') {
    setAuthNote(ctx, input.connection_id, null);
  } else if (input.note !== undefined) {
    setAuthNote(ctx, input.connection_id, input.note);
  }
  ctx.wrote('sync.connection', input.connection_id);
  return { connection_id: input.connection_id, status: input.status };
}

// ── Broker-owned credentials (issue #304) ───────────────────────────────
// A connection may carry its own credential — `oauth2` (BYO client) or
// `api_key` (a static PAT) — instead of borrowing the harness's ambient
// auth. The secret cells are sealed columns; the ONLY consumer is the
// gateway broker, which injects them into `ctx.fetch` toward the
// connection's `allowed_hosts` and never hands them to connector code.
// Both commands here are CONFIRM-GATED (issue #308 A1/A2): risk stopped
// parking anything when #306 made confirmation a command property, and
// these two touch exactly what must never move on a model's say-so —
// `configure_credential` can rewrite `allowed_hosts` (the #304 structural
// pin) and `client_secret`; `store_tokens` can substitute the token pair
// the drains ride. Every legitimate non-owner path is unaffected: the
// broker's ceremony/refresh and the connections routes all invoke on the
// owner plane, which never parks.

const CONFIGURE_CREDENTIAL: CommandDefinition = {
  name: 'sync.configure_credential',
  ownerSchema: 'sync',
  inputSchema: {
    type: 'object',
    required: ['kind', 'label', 'cred_kind'],
    additionalProperties: false,
    properties: {
      kind: { type: 'string', minLength: 1 },
      label: { type: 'string', minLength: 1 },
      // `none` detaches: every credential cell nulls, the connection falls
      // back to the harness-ambient lane.
      cred_kind: { type: 'string', enum: ['oauth2', 'api_key', 'none'] },
      // Wizard/docs key, e.g. `google`, `github` — names which BYO-client
      // walkthrough applies. Free-form.
      provider: { type: 'string', minLength: 1 },
      auth_url: { type: 'string', minLength: 1 },
      token_url: { type: 'string', minLength: 1 },
      scopes: { type: 'string', minLength: 1 },
      client_id: { type: 'string', minLength: 1 },
      client_secret: { type: 'string', minLength: 1 },
      api_key: { type: 'string', minLength: 1 },
      allowed_hosts: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
      },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['connection_id', 'cred_kind', 'status'],
    properties: {
      connection_id: { type: 'string' },
      cred_kind: { type: 'string' },
      status: { type: 'string' },
    },
  },
  preconditions: [],
  postconditions: [],
  sealedInput: ['client_secret', 'api_key'],
  idempotency: 'idempotent',
  // Attaching a credential decides where secrets may flow: `allowed_hosts`
  // IS the #304 anti-exfiltration pin, so a non-owner proposing this parks
  // (issue #308 A1 — `confirm`, not risk, is what parks post-#306).
  risk: 'medium',
  confirm: true,
  handler: configureCredential,
};

function configureCredential(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    kind: string;
    label: string;
    cred_kind: 'oauth2' | 'api_key' | 'none';
    provider?: string;
    auth_url?: string;
    token_url?: string;
    scopes?: string;
    client_id?: string;
    client_secret?: string;
    api_key?: string;
    allowed_hosts?: string[];
  };
  const connectionId = ensureConnectionTx(ctx.db, { kind: input.kind, label: input.label });
  if (input.cred_kind === 'none') {
    // Detach = DELETE the sidecar row: no half-shredded credentials, and
    // the connection is back on the harness-ambient lane.
    ctx.db
      .prepare('DELETE FROM sync_connection_credential WHERE connection_id = ?')
      .run(connectionId);
    ctx.db.prepare('DELETE FROM sync_connection_health WHERE connection_id = ?').run(connectionId);
    ctx.wrote('sync.connection', connectionId);
    ctx.cite({
      claim: `detached the credential from ${input.kind} "${input.label}" — back on the harness-ambient lane`,
      entityType: 'sync.connection',
      entityId: connectionId,
    });
    return { connection_id: connectionId, cred_kind: 'none', status: 'active' };
  }
  // The host pin is the anti-exfiltration invariant (issue #304 decision 2):
  // a credential without a host list would be injectable anywhere connector
  // code points ctx.fetch, so both kinds refuse to configure without one.
  if (!input.allowed_hosts || input.allowed_hosts.length === 0) {
    throw new Error(
      `cred_kind "${input.cred_kind}" requires allowed_hosts — the hosts this credential may be injected toward (issue #304)`,
    );
  }
  if (input.cred_kind === 'oauth2') {
    if (!input.auth_url || !input.token_url || !input.client_id) {
      throw new Error(
        'cred_kind "oauth2" requires auth_url, token_url and client_id (the owner-registered BYO client, issue #304)',
      );
    }
  } else if (!input.api_key) {
    throw new Error('cred_kind "api_key" requires api_key');
  }
  // Switching kinds never leaks the previous credential's cells: the whole
  // sidecar row is replaced, unset optionals to NULL. oauth2 starts life in
  // needs-auth — the consent ceremony (authorize + store_tokens) is what
  // proves reach; an api_key is complete as configured.
  const status = input.cred_kind === 'oauth2' ? 'needs-auth' : 'active';
  ctx.db
    .prepare(
      `INSERT OR REPLACE INTO sync_connection_credential
         (connection_id, cred_kind, provider, auth_url, token_url, scopes,
          client_id, client_secret, access_token, refresh_token, api_key,
          token_expires_at, allowed_hosts, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?)`,
    )
    .run(
      connectionId,
      input.cred_kind,
      input.provider ?? null,
      input.auth_url ?? null,
      input.token_url ?? null,
      input.scopes ?? null,
      input.client_id ?? null,
      input.client_secret ?? null,
      input.api_key ?? null,
      JSON.stringify(input.allowed_hosts),
      ctx.now,
    );
  ctx.db
    .prepare('UPDATE sync_connection SET status = ? WHERE connection_id = ?')
    .run(status, connectionId);
  setAuthNote(
    ctx,
    connectionId,
    input.cred_kind === 'oauth2' ? 'authorization pending — run Connect' : null,
  );
  ctx.wrote('sync.connection', connectionId);
  ctx.wrote('sync.connection_credential', connectionId);
  ctx.cite({
    claim: `configured a ${input.cred_kind} credential on ${input.kind} "${input.label}" pinned to ${input.allowed_hosts.join(', ')}`,
    entityType: 'sync.connection',
    entityId: connectionId,
  });
  return { connection_id: connectionId, cred_kind: input.cred_kind, status };
}

/** Upsert (or clear) the connection's owner-readable health note. */
function setAuthNote(ctx: HandlerCtx, connectionId: string, note: string | null): void {
  if (note === null) {
    ctx.db.prepare('DELETE FROM sync_connection_health WHERE connection_id = ?').run(connectionId);
    return;
  }
  ctx.db
    .prepare(
      `INSERT INTO sync_connection_health (connection_id, auth_note, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (connection_id) DO UPDATE SET auth_note = excluded.auth_note, updated_at = excluded.updated_at`,
    )
    .run(connectionId, note, ctx.now);
}

const STORE_TOKENS: CommandDefinition = {
  name: 'sync.store_tokens',
  ownerSchema: 'sync',
  inputSchema: {
    type: 'object',
    required: ['connection_id', 'access_token'],
    additionalProperties: false,
    properties: {
      connection_id: { type: 'string', minLength: 1 },
      access_token: { type: 'string', minLength: 1 },
      // Absent on refresh responses that do not rotate — the stored one
      // stays. Rotating providers MUST land the new one in the same act.
      refresh_token: { type: 'string', minLength: 1 },
      expires_at: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['connection_id', 'status'],
    properties: { connection_id: { type: 'string' }, status: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'connection_is_oauth2',
      sql: `SELECT count(*) AS n FROM sync_connection_credential WHERE connection_id = :connection_id AND cred_kind = 'oauth2'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [],
  sealedInput: ['access_token', 'refresh_token'],
  idempotency: 'idempotent',
  // Low salience but confirm-gated (issue #308 A2): swapping the stored
  // token pair re-principals every future drain, and only the broker's
  // owner-plane ceremony/refresh has business landing tokens.
  risk: 'low',
  confirm: true,
  handler: storeTokens,
};

function storeTokens(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    connection_id: string;
    access_token: string;
    refresh_token?: string;
    expires_at?: string;
  };
  ctx.db
    .prepare(
      `UPDATE sync_connection_credential SET access_token = ?,
         refresh_token = COALESCE(?, refresh_token),
         token_expires_at = ?, updated_at = ?
       WHERE connection_id = ?`,
    )
    .run(
      input.access_token,
      input.refresh_token ?? null,
      input.expires_at ?? null,
      ctx.now,
      input.connection_id,
    );
  ctx.db
    .prepare(`UPDATE sync_connection SET status = 'active' WHERE connection_id = ?`)
    .run(input.connection_id);
  setAuthNote(ctx, input.connection_id, null);
  ctx.wrote('sync.connection', input.connection_id);
  ctx.wrote('sync.connection_credential', input.connection_id);
  ctx.cite({
    claim: `landed a fresh token pair on connection ${input.connection_id}${input.expires_at ? ` (expires ${input.expires_at})` : ''}`,
    entityType: 'sync.connection',
    entityId: input.connection_id,
  });
  return { connection_id: input.connection_id, status: 'active' };
}

/** Register the staging + connection-lifecycle commands on a gateway. */
export function registerSyncCommands(gateway: Gateway): void {
  gateway.registerCommand(STAGE_ROWS);
  gateway.registerCommand(PUBLISH_BATCH);
  gateway.registerCommand(BEGIN_RUN);
  gateway.registerCommand(FINISH_RUN);
  gateway.registerCommand(SET_CURSOR);
  gateway.registerCommand(SET_CONNECTION_STATUS);
  gateway.registerCommand(CONFIGURE_CREDENTIAL);
  gateway.registerCommand(STORE_TOKENS);
}
