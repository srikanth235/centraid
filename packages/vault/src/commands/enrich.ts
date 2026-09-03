// governance: allow-repo-hygiene file-size-limit (#731) the typed enrichment command pack keeps OCR, transcript, embedding, face, and provenance validation in one derivative-write boundary.

import { stampDerivation } from "../enrich/derivation.js";
import {
  readEnrichConsentId,
  recordEnrichConsent,
} from "../enrich/egress-consent.js";
import type {
  EnrichConsentDecision,
  EnrichEgressClass,
} from "../enrich/egress-consent.js";
import { rebuildFaceClusters } from "../enrich/face-clusters.js";
import { encodeVector } from "../enrich/similarity.js";
import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";

const MAX_EMBEDDING_DIM = 4096;

const SET_EXTRACTED_TEXT: CommandDefinition = {
  name: "core.set_extracted_text",
  ownerSchema: "core",
  inputSchema: {
    type: "object",
    required: ["content_id", "text"],
    additionalProperties: false,
    properties: {
      content_id: { type: "string", minLength: 1 },
      text: { type: "string", minLength: 1 },
      variant: { type: "string", enum: ["text", "transcript"] },
      capability: { type: "string", minLength: 1 },
      model: { type: "string", minLength: 1 },
      profile: { type: "string", minLength: 1 },
      prompt_rev: { type: "string", minLength: 1 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      regions: {
        type: "array",
        items: {
          type: "object",
          required: ["text"],
          additionalProperties: false,
          properties: {
            text: { type: "string" },
            box: {
              type: "array",
              minItems: 4,
              maxItems: 4,
              items: { type: "integer", minimum: 0 },
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      },
    },
  },
  outputSchema: {
    type: "object",
    required: ["content_id"],
    properties: {
      content_id: { type: "string" },
      replaced: { type: "integer" },
    },
  },
  preconditions: [
    {
      name: "content_item_live",
      sql: `SELECT count(*) AS n FROM core_content_item WHERE content_id = :content_id AND deleted_at IS NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "text_derivative_present",
      sql: `SELECT count(*) AS n FROM core_content_derivative
             WHERE content_id = :content_id AND variant = COALESCE(:variant, 'text')`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "retry-safe",
  risk: "medium",
  handler: setExtractedText,
};

type ExtractedTextRegion = {
  text: string;
  box?: [number, number, number, number];
  confidence?: number;
};

function setExtractedText(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    content_id: string;
    text: string;
    variant?: "text" | "transcript";
    capability?: string;
    model?: string;
    profile?: string;
    prompt_rev?: string;
    confidence?: number;
    regions?: ExtractedTextRegion[];
  };
  const result = writeExtractedText(
    ctx,
    input.content_id,
    input.text,
    input.variant ?? "text"
  );
  if (input.model && input.capability) {
    const regions =
      input.regions === undefined
        ? undefined
        : dropOutOfBoundsRegions(ctx, input.content_id, input.regions);
    stampDerivation(ctx.db, {
      targetType: "core.content_item",
      targetId: input.content_id,
      variant: input.variant ?? "text",
      capability: input.capability,
      model: input.model,
      ...(input.profile ? { profile: input.profile } : {}),
      payload: {
        ...(input.prompt_rev ? { prompt_rev: input.prompt_rev } : {}),
        ...(input.confidence === undefined
          ? {}
          : { confidence: input.confidence }),
        ...(regions === undefined ? {} : { regions }),
      },
      now: ctx.now,
    });
    ctx.wrote("enrich.derivation", input.content_id);
  }
  return result;
}

function dropOutOfBoundsRegions(
  ctx: HandlerCtx,
  contentId: string,
  regions: ExtractedTextRegion[]
): ExtractedTextRegion[] {
  const asset = ctx.db
    .prepare("SELECT width, height FROM media_asset WHERE content_id = ?")
    .get(contentId) as
    | { width: number | null; height: number | null }
    | undefined;
  const width = asset?.width ?? null;
  const height = asset?.height ?? null;
  if (width === null && height === null) return regions;
  return regions.map((region) => {
    if (!region.box) return region;
    const [x, y, w, h] = region.box;
    const inBounds =
      (width === null || x + w <= width) &&
      (height === null || y + h <= height);
    if (inBounds) return region;
    const { box: _box, ...rest } = region;
    return rest;
  });
}

export function writeExtractedText(
  ctx: HandlerCtx,
  contentId: string,
  text: string,
  variant: "text" | "transcript" = "text"
): Record<string, unknown> {
  const existing = ctx.db
    .prepare(
      `SELECT derivative_id FROM core_content_derivative WHERE content_id = ? AND variant = ?`
    )
    .get(contentId, variant) as { derivative_id: string } | undefined;
  const byteSize = Buffer.byteLength(text, "utf8");
  if (existing) {
    ctx.db
      .prepare(`DELETE FROM core_content_derivative WHERE derivative_id = ?`)
      .run(existing.derivative_id);
  }
  const derivativeId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_content_derivative (derivative_id, content_id, variant, sha256, media_type, byte_size, text_content, created_at)
       VALUES (?, ?, ?, NULL, 'text/plain', ?, ?, ?)`
    )
    .run(derivativeId, contentId, variant, byteSize, text, ctx.now);
  ctx.wrote("core.content_derivative", derivativeId);
  ctx.cite({
    claim: `${variant} (${byteSize} bytes) now feeds the content search index`,
    entityType: "core.content_item",
    entityId: contentId,
  });
  return { content_id: contentId, replaced: existing ? 1 : 0 };
}

const ANSWER_FACE_PROPOSAL: CommandDefinition = {
  name: "media.answer_face_proposal",
  ownerSchema: "media",
  inputSchema: {
    type: "object",
    required: ["region_id", "answer"],
    additionalProperties: false,
    properties: {
      region_id: { type: "string", minLength: 1 },
      answer: { type: "string", enum: ["confirm", "reject", "dismiss"] },
      party_id: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["region_id", "review_state"],
    properties: {
      region_id: { type: "string" },
      review_state: { type: "string" },
    },
  },
  preconditions: [
    {
      name: "region_exists",
      sql: `SELECT count(*) AS n FROM media_face_region WHERE region_id = :region_id`,
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "answer_names_a_party_iff_confirm",
      sql: `SELECT CASE
                     WHEN :answer = 'confirm'
                       THEN (SELECT count(*) FROM core_party WHERE party_id = :party_id)
                     ELSE (CASE WHEN :party_id IS NULL THEN 1 ELSE 0 END)
                   END AS n`,
      column: "n",
      op: "eq",
      value: 1,
      message:
        "a 'confirm' answer must name a party that exists in this vault, and 'reject'/'dismiss' must name none",
    },
  ],
  postconditions: [
    {
      name: "answer_recorded",
      sql: `SELECT count(*) AS n FROM media_face_region
             WHERE region_id = :region_id
               AND review_state = (CASE :answer
                                     WHEN 'confirm' THEN 'confirmed'
                                     WHEN 'reject'  THEN 'rejected'
                                     ELSE 'dismissed' END)`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "retry-safe",
  risk: "low",
  handler: answerFaceProposal,
};

const FACE_ANSWERS = {
  confirm: {
    state: "confirmed",
    keepsParty: true,
    claim: (partyId: string | null) =>
      `face region confirmed as party ${partyId}`,
  },
  reject: {
    state: "rejected",
    keepsParty: false,
    claim: () =>
      "face proposal rejected — the region is remembered as answered so it is never proposed again",
  },
  dismiss: {
    state: "dismissed",
    keepsParty: false,
    claim: () =>
      "face reviewed and deliberately left unnamed — the region stays, the queue does not",
  },
} as const satisfies Record<
  string,
  {
    state: string;
    keepsParty: boolean;
    claim: (partyId: string | null) => string;
  }
>;

type FaceAnswer = keyof typeof FACE_ANSWERS;

function answerFaceProposal(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    region_id: string;
    answer: FaceAnswer;
    party_id?: string;
  };
  const answer = FACE_ANSWERS[input.answer];
  const confirmer = answer.keepsParty
    ? (ctx.identity.partyId ?? ownerPartyId(ctx))
    : null;
  const partyId = answer.keepsParty ? (input.party_id ?? null) : null;
  ctx.db
    .prepare(
      `UPDATE media_face_region
          SET review_state = ?, party_id = ?, confirmed_by_party_id = ?
        WHERE region_id = ?`
    )
    .run(answer.state, partyId, confirmer, input.region_id);
  ctx.wrote("media.face_region", input.region_id);
  ctx.cite({
    claim: answer.claim(partyId),
    entityType: "media.face_region",
    entityId: input.region_id,
  });
  return { region_id: input.region_id, review_state: answer.state };
}

const SET_CONNECTION_TRUST: CommandDefinition = {
  name: "sync.set_connection_trust",
  ownerSchema: "sync",
  inputSchema: {
    type: "object",
    required: ["connection_id", "trust"],
    additionalProperties: false,
    properties: {
      connection_id: { type: "string", minLength: 1 },
      trust: { type: "string", enum: ["staged", "auto-publish"] },
      enrich_classes: {
        type: "array",
        items: {
          type: "string",
          enum: ["caption", "tag", "face", "collection", "filing"],
        },
      },
    },
  },
  outputSchema: {
    type: "object",
    required: ["connection_id", "trust"],
    properties: {
      connection_id: { type: "string" },
      trust: { type: "string" },
    },
  },
  preconditions: [
    {
      name: "connection_exists",
      sql: `SELECT count(*) AS n FROM sync_connection WHERE connection_id = :connection_id`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "trust_applied",
      sql: `SELECT count(*) AS n FROM sync_connection WHERE connection_id = :connection_id AND trust = :trust`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "retry-safe",
  risk: "high",
  confirm: true,
  handler: (ctx) => {
    const input = ctx.input as {
      connection_id: string;
      trust: "staged" | "auto-publish";
      enrich_classes?: string[];
    };
    const classes = input.enrich_classes
      ? JSON.stringify([...new Set(input.enrich_classes)])
      : null;
    ctx.db
      .prepare(
        "UPDATE sync_connection SET trust = ?, enrich_classes_json = ? WHERE connection_id = ?"
      )
      .run(input.trust, classes, input.connection_id);
    ctx.wrote("sync.connection", input.connection_id);
    ctx.cite({
      claim: `connection trust set to ${input.trust}${classes ? ` (classes: ${input.enrich_classes!.join(", ")})` : ""}`,
      entityType: "sync.connection",
      entityId: input.connection_id,
    });
    return { connection_id: input.connection_id, trust: input.trust };
  },
};

const REQUEST_ENRICHMENT: CommandDefinition = {
  name: "enrich.request_enrichment",
  ownerSchema: "enrich",
  inputSchema: {
    type: "object",
    required: ["entity_type", "reason"],
    additionalProperties: false,
    properties: {
      entity_type: { type: "string", minLength: 1 },
      entity_id: { type: "string", minLength: 1 },
      reason: { type: "string", enum: ["search-miss", "on-view", "manual"] },
      detail: { type: "string" },
      capability: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["request_id"],
    properties: { request_id: { type: "string" } },
  },
  preconditions: [],
  postconditions: [
    {
      name: "request_recorded",
      sql: `SELECT count(*) AS n FROM enrich_request WHERE request_id = :request_id`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "retry-safe",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as {
      entity_type: string;
      entity_id?: string;
      reason: "search-miss" | "on-view" | "manual";
      detail?: string;
      capability?: string;
    };
    if (input.reason === "manual" && !input.capability)
      throw new Error(
        "enrich.request_enrichment: a 'manual' request must name the `capability` it is asking for — " +
          "an untagged owner ask would enable every enricher, not the one the member consented to"
      );
    const requestId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO enrich_request (request_id, target_type, target_id, reason, detail, capability, requested_at, drained_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        requestId,
        input.entity_type,
        input.entity_id ?? null,
        input.reason,
        input.detail ?? null,
        input.capability ?? null,
        ctx.now
      );
    ctx.wrote("enrich.request", requestId);
    if (input.reason === "manual" && input.capability) {
      recordEnrichConsent(ctx.db, {
        capability: input.capability,
        egress: "on-device",
        scopeRef: "",
        decision: "granted",
        now: ctx.now,
      });
      const consentId = readEnrichConsentId(ctx.db, {
        capability: input.capability,
        egress: "on-device",
        scopeRef: "",
      });
      if (consentId) ctx.wrote("share.authority", consentId);
    }
    return { request_id: requestId };
  },
};

const RECORD_CONSENT: CommandDefinition = {
  name: "enrich.record_consent",
  ownerSchema: "enrich",
  inputSchema: {
    type: "object",
    required: ["capability", "egress", "decision"],
    additionalProperties: false,
    properties: {
      capability: { type: "string", minLength: 1, maxLength: 64 },
      egress: { type: "string", enum: ["on-device", "gateway", "provider"] },
      scope_ref: { type: "string", maxLength: 128 },
      decision: { type: "string", enum: ["granted", "declined"] },
    },
  },
  outputSchema: {
    type: "object",
    required: ["capability", "egress", "scope_ref", "decision"],
    properties: {
      capability: { type: "string" },
      egress: { type: "string" },
      scope_ref: { type: "string" },
      decision: { type: "string" },
    },
  },
  preconditions: [],
  postconditions: [
    {
      name: "answer_recorded",
      sql: `SELECT count(*) AS n FROM share_authority
             WHERE principal_kind = 'harness' AND subject_type = 'enrich.scope'
               AND verb = :capability AND principal_id = :egress
               AND subject_id = :scope_ref AND decision = :decision
               AND revoked_at IS NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  risk: "high",
  confirm: true,
  handler: (ctx) => {
    const input = ctx.input as {
      capability: string;
      egress: EnrichEgressClass;
      scope_ref?: string;
      decision: EnrichConsentDecision;
    };
    const scopeRef = input.scope_ref ?? "";
    recordEnrichConsent(ctx.db, {
      capability: input.capability,
      egress: input.egress,
      scopeRef,
      decision: input.decision,
      now: ctx.now,
    });
    const storedId = readEnrichConsentId(ctx.db, {
      capability: input.capability,
      egress: input.egress,
      scopeRef,
    });
    if (storedId) ctx.wrote("share.authority", storedId);
    return {
      capability: input.capability,
      egress: input.egress,
      scope_ref: scopeRef,
      decision: input.decision,
    };
  },
};

const UPSERT_EMBEDDING: CommandDefinition = {
  name: "enrich.upsert_embedding",
  ownerSchema: "enrich",
  inputSchema: {
    type: "object",
    required: ["entity_type", "entity_id", "model", "vector"],
    additionalProperties: false,
    properties: {
      entity_type: { type: "string", minLength: 1 },
      entity_id: { type: "string", minLength: 1 },
      model: { type: "string", minLength: 1 },
      vector: {
        type: "array",
        minItems: 1,
        maxItems: MAX_EMBEDDING_DIM,
        items: { type: "number" },
      },
      capability: { type: "string", enum: ["embed-image", "embed-text"] },
      source_version: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["embedding_id", "dim"],
    properties: { embedding_id: { type: "string" }, dim: { type: "integer" } },
  },
  preconditions: [],
  postconditions: [
    {
      name: "embedding_present",
      sql: `SELECT count(*) AS n FROM enrich_embedding
             WHERE target_type = :entity_type AND target_id = :entity_id AND model = :model`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "retry-safe",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as {
      entity_type: string;
      entity_id: string;
      model: string;
      vector: number[];
      capability?: "embed-image" | "embed-text";
      source_version?: string;
    };
    const existing = ctx.db
      .prepare(
        `SELECT embedding_id FROM enrich_embedding WHERE target_type = ? AND target_id = ? AND model = ?`
      )
      .get(input.entity_type, input.entity_id, input.model) as
      | { embedding_id: string }
      | undefined;
    const embeddingId = existing?.embedding_id ?? ctx.newId();
    const vector = encodeVector(input.vector);
    if (existing) {
      ctx.db
        .prepare(
          `UPDATE enrich_embedding SET dim = ?, vector = ?, created_at = ? WHERE embedding_id = ?`
        )
        .run(input.vector.length, vector, ctx.now, embeddingId);
    } else {
      ctx.db
        .prepare(
          `INSERT INTO enrich_embedding (embedding_id, target_type, target_id, model, dim, vector, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          embeddingId,
          input.entity_type,
          input.entity_id,
          input.model,
          input.vector.length,
          vector,
          ctx.now
        );
    }
    ctx.wrote("enrich.embedding", embeddingId);
    if (input.capability) {
      stampDerivation(ctx.db, {
        targetType: input.entity_type,
        targetId: input.entity_id,
        variant: "embedding",
        capability: input.capability,
        model: input.model,
        ...(input.source_version === undefined
          ? {}
          : { payload: { source_version: input.source_version } }),
        now: ctx.now,
      });
      ctx.wrote("enrich.derivation", input.entity_id);
    }
    return { embedding_id: embeddingId, dim: input.vector.length };
  },
};

const MARK_REQUESTS_DRAINED: CommandDefinition = {
  name: "enrich.mark_requests_drained",
  ownerSchema: "enrich",
  inputSchema: {
    type: "object",
    required: ["request_ids"],
    additionalProperties: false,
    properties: {
      request_ids: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: { type: "string", minLength: 1 },
      },
    },
  },
  outputSchema: {
    type: "object",
    required: ["drained"],
    properties: { drained: { type: "integer" } },
  },
  preconditions: [],
  postconditions: [],
  idempotency: "retry-safe",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as { request_ids: string[] };
    let drained = 0;
    const mark = ctx.db.prepare(
      `UPDATE enrich_request SET drained_at = ?
        WHERE request_id = ? AND drained_at IS NULL
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`
    );
    for (const requestId of input.request_ids) {
      const changed = mark.run(ctx.now, requestId, ctx.now).changes;
      if (changed > 0) {
        drained += Number(changed);
        ctx.wrote("enrich.request", requestId);
      }
    }
    return { drained };
  },
};

const REBUILD_FACE_CLUSTERS: CommandDefinition = {
  name: "enrich.rebuild_face_clusters",
  ownerSchema: "enrich",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  outputSchema: {
    type: "object",
    required: ["matched", "clusters", "clustered", "updated"],
    properties: {
      matched: { type: "integer" },
      clusters: { type: "integer" },
      clustered: { type: "integer" },
      updated: { type: "integer" },
    },
  },
  preconditions: [],
  postconditions: [],
  idempotency: "retry-safe",
  risk: "medium",
  handler: (ctx) => {
    const before = ctx.db
      .prepare("SELECT region_id FROM media_face_cluster")
      .all() as unknown as { region_id: string }[];
    const result = rebuildFaceClusters(ctx.db, { now: ctx.now });
    if (result.updated > 0) {
      const after = ctx.db
        .prepare("SELECT region_id FROM media_face_cluster")
        .all() as unknown as { region_id: string }[];
      for (const regionId of new Set(
        [...before, ...after].map((row) => row.region_id)
      )) {
        ctx.wrote("media.face_cluster", regionId);
      }
    }
    return {
      matched: result.matched,
      clusters: result.clusters,
      clustered: result.clustered,
      updated: result.updated,
    };
  },
};

const UPSERT_FACES: CommandDefinition = {
  name: "enrich.upsert_faces",
  ownerSchema: "enrich",
  inputSchema: {
    type: "object",
    required: ["asset_id", "model", "faces"],
    additionalProperties: false,
    properties: {
      asset_id: { type: "string", minLength: 1 },
      model: { type: "string", minLength: 1 },
      faces: {
        type: "array",
        maxItems: 100,
        items: {
          type: "object",
          required: ["box", "confidence", "embedding"],
          additionalProperties: false,
          properties: {
            box: {
              type: "array",
              minItems: 4,
              maxItems: 4,
              items: { type: "integer", minimum: 0 },
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            embedding: {
              type: "array",
              minItems: 1,
              maxItems: MAX_EMBEDDING_DIM,
              items: { type: "number" },
            },
          },
        },
      },
    },
  },
  outputSchema: {
    type: "object",
    required: ["regions"],
    properties: { regions: { type: "integer" } },
  },
  preconditions: [
    {
      name: "asset_live",
      sql: "SELECT count(*) AS n FROM media_asset WHERE asset_id = :asset_id AND deleted_at IS NULL",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [],
  idempotency: "retry-safe",
  risk: "medium",
  handler: (ctx) => {
    const input = ctx.input as {
      asset_id: string;
      model: string;
      faces: {
        box: [number, number, number, number];
        confidence: number;
        embedding: number[];
      }[];
    };
    const asset = ctx.db
      .prepare("SELECT width, height FROM media_asset WHERE asset_id = ?")
      .get(input.asset_id) as { width: number | null; height: number | null };
    for (const face of input.faces) {
      const [x, y, width, height] = face.box;
      if (
        width <= 0 ||
        height <= 0 ||
        (asset.width !== null && x + width > asset.width) ||
        (asset.height !== null && y + height > asset.height)
      )
        throw new Error("face box lies outside the asset");
      if (face.embedding.some((value) => !Number.isFinite(value)))
        throw new Error("face embedding contains a non-finite value");
    }
    const proposed = ctx.db
      .prepare(
        "SELECT region_id FROM media_face_region WHERE asset_id = ? AND review_state = 'proposed'"
      )
      .all(input.asset_id) as unknown as { region_id: string }[];
    for (const row of proposed) {
      ctx.db
        .prepare(
          "DELETE FROM enrich_embedding WHERE target_type = 'media.face_region' AND target_id = ?"
        )
        .run(row.region_id);
      ctx.db
        .prepare("DELETE FROM media_face_region WHERE region_id = ?")
        .run(row.region_id);
      ctx.wrote("media.face_region", row.region_id);
    }
    for (const face of input.faces) {
      const regionId = ctx.newId();
      ctx.db
        .prepare(
          "INSERT INTO media_face_region (region_id, asset_id, bbox_json, confidence) VALUES (?, ?, ?, ?)"
        )
        .run(
          regionId,
          input.asset_id,
          JSON.stringify(face.box),
          face.confidence
        );
      const embeddingId = ctx.newId();
      ctx.db
        .prepare(
          "INSERT INTO enrich_embedding (embedding_id, target_type, target_id, model, dim, vector, created_at) VALUES (?, 'media.face_region', ?, ?, ?, ?, ?)"
        )
        .run(
          embeddingId,
          regionId,
          input.model,
          face.embedding.length,
          encodeVector(face.embedding),
          ctx.now
        );
      ctx.wrote("media.face_region", regionId);
      ctx.wrote("enrich.embedding", embeddingId);
    }
    stampDerivation(ctx.db, {
      targetType: "media.asset",
      targetId: input.asset_id,
      variant: "faces",
      capability: "faces",
      model: input.model,
      payload: { count: input.faces.length },
      now: ctx.now,
    });
    ctx.wrote("enrich.derivation", input.asset_id);
    return { regions: input.faces.length };
  },
};

function ownerPartyId(ctx: HandlerCtx): string {
  const owner = ctx.db
    .prepare("SELECT self_party_id FROM core_vault LIMIT 1")
    .get() as { self_party_id: string | null } | undefined;
  if (!owner?.self_party_id) throw new Error("vault has no owner");
  return owner.self_party_id;
}

export function registerEnrichCommands(gateway: Gateway): void {
  gateway.registerCommand(SET_EXTRACTED_TEXT);
  gateway.registerCommand(ANSWER_FACE_PROPOSAL);
  gateway.registerCommand(SET_CONNECTION_TRUST);
  gateway.registerCommand(REQUEST_ENRICHMENT);
  gateway.registerCommand(RECORD_CONSENT);
  gateway.registerCommand(UPSERT_EMBEDDING);
  gateway.registerCommand(MARK_REQUESTS_DRAINED);
  gateway.registerCommand(UPSERT_FACES);
  gateway.registerCommand(REBUILD_FACE_CLUSTERS);
}
