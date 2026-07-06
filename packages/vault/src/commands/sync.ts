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
import { applyBatchTx, ensureConnectionTx, stageBatchTx, type StageCandidate } from '../ingest/staging.js';

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
    },
  },
  preconditions: [],
  postconditions: [
    {
      name: 'batch_staged_as_draft',
      sql: `SELECT count(*) AS n FROM sync_import_batch WHERE batch_id = :batch_id AND status = 'draft'`,
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
  }
  const connectionId = ensureConnectionTx(ctx.db, { kind: input.kind, label: input.label });
  const candidates: StageCandidate[] = input.rows.map((r) => ({
    entityType: r.entity_type,
    externalId: r.external_id,
    payload: r.payload,
  }));
  const { batchId, counts } = stageBatchTx(ctx.db, connectionId, candidates, PUBLISHERS, ctx.now);
  ctx.wrote('sync.import_batch', batchId);
  ctx.cite({
    claim: `staged ${input.rows.length} row(s) from ${input.kind} "${input.label}" as draft ${batchId} (${counts.create} create, ${counts.update} update, ${counts.skip} skip)`,
    entityType: 'sync.import_batch',
    entityId: batchId,
  });
  return { batch_id: batchId, connection_id: connectionId, staged: counts };
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

/** Register the staging commands on a gateway. */
export function registerSyncCommands(gateway: Gateway): void {
  gateway.registerCommand(STAGE_ROWS);
  gateway.registerCommand(PUBLISH_BATCH);
}
