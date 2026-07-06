// The enrichment command pack (issue #299): the typed verbs the spine's
// non-staged writes ride. Staged output (captions, tags, faces, albums,
// filing) lands through `sync.stage_rows` + the enrich publishers; these
// commands cover what staging cannot express —
//
//   - `core.set_extracted_text`: the OCR/extraction result becomes the
//     content item's inline `text` derivative, so the existing FTS triggers
//     index the PARENT document in-transaction (issue #296's rule). This is
//     how a scanned PDF becomes searchable.
//   - `media.confirm_face` / `media.reject_face`: the owner's half of the
//     face proposal loop the schema always carried (`confirmed_by_party_id`).
//   - `sync.set_connection_trust`: the owner's standing-consent lever — an
//     `auto-publish` enrichment connection is what lets captions land
//     without a review click. Risk `high`: an agent proposing to widen its
//     own trust parks for the owner, structurally.
//   - `enrich.request_enrichment` / `enrich.upsert_embedding`: the
//     on-demand queue and the additive vector index (issue #299 phase 5).

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';
import { encodeVector } from '../enrich/similarity.js';

/** Embedding dimension ceiling — bounds one row at ~16 KiB of float32. */
const MAX_EMBEDDING_DIM = 4096;

const SET_EXTRACTED_TEXT: CommandDefinition = {
  name: 'core.set_extracted_text',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['content_id', 'text'],
    additionalProperties: false,
    properties: {
      content_id: { type: 'string', minLength: 1 },
      text: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['content_id'],
    properties: { content_id: { type: 'string' }, replaced: { type: 'integer' } },
  },
  preconditions: [
    {
      name: 'content_item_live',
      sql: `SELECT count(*) AS n FROM core_content_item WHERE content_id = :content_id AND deleted_at IS NULL`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'text_derivative_present',
      sql: `SELECT count(*) AS n FROM core_content_derivative WHERE content_id = :content_id AND variant = 'text'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'retry-safe',
  risk: 'medium',
  handler: setExtractedText,
};

function setExtractedText(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { content_id: string; text: string };
  const existing = ctx.db
    .prepare(
      `SELECT derivative_id FROM core_content_derivative WHERE content_id = ? AND variant = 'text'`,
    )
    .get(input.content_id) as { derivative_id: string } | undefined;
  const byteSize = Buffer.byteLength(input.text, 'utf8');
  if (existing) {
    ctx.db
      .prepare(
        `UPDATE core_content_derivative SET text_content = ?, byte_size = ? WHERE derivative_id = ?`,
      )
      .run(input.text, byteSize, existing.derivative_id);
    ctx.wrote('core.content_derivative', existing.derivative_id);
  } else {
    const derivativeId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO core_content_derivative (derivative_id, content_id, variant, sha256, media_type, byte_size, text_content, created_at)
         VALUES (?, ?, 'text', NULL, 'text/plain', ?, ?, ?)`,
      )
      .run(derivativeId, input.content_id, byteSize, input.text, ctx.now);
    ctx.wrote('core.content_derivative', derivativeId);
  }
  ctx.cite({
    claim: `extracted text (${byteSize} bytes) now feeds the document's search index`,
    entityType: 'core.content_item',
    entityId: input.content_id,
  });
  return { content_id: input.content_id, replaced: existing ? 1 : 0 };
}

const CONFIRM_FACE: CommandDefinition = {
  name: 'media.confirm_face',
  ownerSchema: 'media',
  inputSchema: {
    type: 'object',
    required: ['region_id', 'party_id'],
    additionalProperties: false,
    properties: {
      region_id: { type: 'string', minLength: 1 },
      party_id: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['region_id'],
    properties: { region_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'region_exists',
      sql: `SELECT count(*) AS n FROM media_face_region WHERE region_id = :region_id`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      name: 'party_exists',
      sql: `SELECT count(*) AS n FROM core_party WHERE party_id = :party_id`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'region_confirmed',
      sql: `SELECT count(*) AS n FROM media_face_region WHERE region_id = :region_id AND confirmed_by_party_id IS NOT NULL`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'retry-safe',
  // Low by design: confirm/reject operate on DERIVED proposals — the same
  // curation class as captioning (media.update_asset) — so the in-app
  // loop stays live under the app ceiling instead of parking every click.
  risk: 'low',
  handler: confirmFace,
};

function confirmFace(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { region_id: string; party_id: string };
  const confirmer = ctx.identity.partyId ?? ownerPartyId(ctx);
  ctx.db
    .prepare(
      'UPDATE media_face_region SET party_id = ?, confirmed_by_party_id = ? WHERE region_id = ?',
    )
    .run(input.party_id, confirmer, input.region_id);
  ctx.wrote('media.face_region', input.region_id);
  ctx.cite({
    claim: `face region confirmed as party ${input.party_id}`,
    entityType: 'media.face_region',
    entityId: input.region_id,
  });
  return { region_id: input.region_id };
}

const REJECT_FACE: CommandDefinition = {
  name: 'media.reject_face',
  ownerSchema: 'media',
  inputSchema: {
    type: 'object',
    required: ['region_id'],
    additionalProperties: false,
    properties: { region_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['region_id'],
    properties: { region_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'region_exists',
      sql: `SELECT count(*) AS n FROM media_face_region WHERE region_id = :region_id`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'region_gone',
      sql: `SELECT count(*) AS n FROM media_face_region WHERE region_id = :region_id`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as { region_id: string };
    ctx.db.prepare('DELETE FROM media_face_region WHERE region_id = ?').run(input.region_id);
    ctx.wrote('media.face_region', input.region_id);
    ctx.cite({
      claim: 'face proposal rejected — the region is derived data and re-derivable',
      entityType: 'media.face_region',
      entityId: input.region_id,
    });
    return { region_id: input.region_id };
  },
};

const SET_CONNECTION_TRUST: CommandDefinition = {
  name: 'sync.set_connection_trust',
  ownerSchema: 'sync',
  inputSchema: {
    type: 'object',
    required: ['connection_id', 'trust'],
    additionalProperties: false,
    properties: {
      connection_id: { type: 'string', minLength: 1 },
      trust: { type: 'string', enum: ['staged', 'auto-publish'] },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['connection_id', 'trust'],
    properties: { connection_id: { type: 'string' }, trust: { type: 'string' } },
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
      name: 'trust_applied',
      sql: `SELECT count(*) AS n FROM sync_connection WHERE connection_id = :connection_id AND trust = :trust`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'retry-safe',
  // The owner's standing-consent lever: widening a connection to
  // auto-publish is above every agent ceiling — a proposal PARKS.
  risk: 'high',
  handler: (ctx) => {
    const input = ctx.input as { connection_id: string; trust: 'staged' | 'auto-publish' };
    ctx.db
      .prepare('UPDATE sync_connection SET trust = ? WHERE connection_id = ?')
      .run(input.trust, input.connection_id);
    ctx.wrote('sync.connection', input.connection_id);
    ctx.cite({
      claim: `connection trust set to ${input.trust}`,
      entityType: 'sync.connection',
      entityId: input.connection_id,
    });
    return { connection_id: input.connection_id, trust: input.trust };
  },
};

const REQUEST_ENRICHMENT: CommandDefinition = {
  name: 'enrich.request_enrichment',
  ownerSchema: 'enrich',
  inputSchema: {
    type: 'object',
    required: ['entity_type', 'reason'],
    additionalProperties: false,
    properties: {
      entity_type: { type: 'string', minLength: 1 },
      entity_id: { type: 'string', minLength: 1 },
      reason: { type: 'string', enum: ['search-miss', 'on-view'] },
      detail: { type: 'string' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['request_id'],
    properties: { request_id: { type: 'string' } },
  },
  preconditions: [],
  postconditions: [
    {
      name: 'request_recorded',
      sql: `SELECT count(*) AS n FROM enrich_request WHERE request_id = :request_id`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'retry-safe',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as {
      entity_type: string;
      entity_id?: string;
      reason: 'search-miss' | 'on-view';
      detail?: string;
    };
    const requestId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO enrich_request (request_id, entity_type, entity_id, reason, detail, requested_at, drained_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        requestId,
        input.entity_type,
        input.entity_id ?? null,
        input.reason,
        input.detail ?? null,
        ctx.now,
      );
    ctx.wrote('enrich.request', requestId);
    return { request_id: requestId };
  },
};

const UPSERT_EMBEDDING: CommandDefinition = {
  name: 'enrich.upsert_embedding',
  ownerSchema: 'enrich',
  inputSchema: {
    type: 'object',
    required: ['entity_type', 'entity_id', 'model', 'vector'],
    additionalProperties: false,
    properties: {
      entity_type: { type: 'string', minLength: 1 },
      entity_id: { type: 'string', minLength: 1 },
      model: { type: 'string', minLength: 1 },
      vector: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_EMBEDDING_DIM,
        items: { type: 'number' },
      },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['embedding_id', 'dim'],
    properties: { embedding_id: { type: 'string' }, dim: { type: 'integer' } },
  },
  preconditions: [],
  postconditions: [
    {
      name: 'embedding_present',
      sql: `SELECT count(*) AS n FROM enrich_embedding
             WHERE entity_type = :entity_type AND entity_id = :entity_id AND model = :model`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'retry-safe',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as {
      entity_type: string;
      entity_id: string;
      model: string;
      vector: number[];
    };
    const existing = ctx.db
      .prepare(
        `SELECT embedding_id FROM enrich_embedding WHERE entity_type = ? AND entity_id = ? AND model = ?`,
      )
      .get(input.entity_type, input.entity_id, input.model) as { embedding_id: string } | undefined;
    const embeddingId = existing?.embedding_id ?? ctx.newId();
    const vector = encodeVector(input.vector);
    if (existing) {
      ctx.db
        .prepare(
          `UPDATE enrich_embedding SET dim = ?, vector = ?, created_at = ? WHERE embedding_id = ?`,
        )
        .run(input.vector.length, vector, ctx.now, embeddingId);
    } else {
      ctx.db
        .prepare(
          `INSERT INTO enrich_embedding (embedding_id, entity_type, entity_id, model, dim, vector, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          embeddingId,
          input.entity_type,
          input.entity_id,
          input.model,
          input.vector.length,
          vector,
          ctx.now,
        );
    }
    ctx.wrote('enrich.embedding', embeddingId);
    return { embedding_id: embeddingId, dim: input.vector.length };
  },
};

/** The vault owner's party — apps and device callers act as the owner. */
function ownerPartyId(ctx: HandlerCtx): string {
  const owner = ctx.db.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get() as
    | { owner_party_id: string | null }
    | undefined;
  if (!owner?.owner_party_id) throw new Error('vault has no owner');
  return owner.owner_party_id;
}

export function registerEnrichCommands(gateway: Gateway): void {
  gateway.registerCommand(SET_EXTRACTED_TEXT);
  gateway.registerCommand(CONFIRM_FACE);
  gateway.registerCommand(REJECT_FACE);
  gateway.registerCommand(SET_CONNECTION_TRUST);
  gateway.registerCommand(REQUEST_ENRICHMENT);
  gateway.registerCommand(UPSERT_EMBEDDING);
}
