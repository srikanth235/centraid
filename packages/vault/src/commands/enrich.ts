// governance: allow-repo-hygiene file-size-limit (#731) the typed enrichment command pack keeps OCR, transcript, embedding, face, and provenance validation in one derivative-write boundary.
// The enrichment command pack (issue #299): the typed verbs the spine's
// non-staged writes ride. Staged output (captions, tags, faces, albums,
// filing) lands through `sync.stage_rows` + the enrich publishers; these
// commands cover what staging cannot express —
//
//   - `core.set_extracted_text`: the OCR/extraction result becomes the
//     content item's inline `text` derivative, so the existing FTS triggers
//     index the PARENT document in-transaction (issue #296's rule). This is
//     how a scanned PDF becomes searchable.
//   - `media.answer_face_proposal`: the owner's half of the face proposal
//     loop, as ONE verb with three answers. It replaces the `confirm_face` /
//     `reject_face` pair outright (issue #712) — see that command's own
//     header for why two verbs could not finish a review queue.
//   - `sync.set_connection_trust`: the owner's standing-consent lever — an
//     `auto-publish` enrichment connection is what lets captions land
//     without a review click. Risk `high`: an agent proposing to widen its
//     own trust parks for the owner, structurally.
//   - `enrich.request_enrichment` / `enrich.upsert_embedding`: the
//     on-demand queue and the additive vector index (issue #299 phase 5).

import { stampDerivation } from "../enrich/derivation.js";
import { rebuildFaceClusters } from "../enrich/face-clusters.js";
import { encodeVector } from "../enrich/similarity.js";
import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";

/** Embedding dimension ceiling — bounds one row at ~16 KiB of float32. */
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

/**
 * OCR boxes are declared against ONE asset's pixel dimensions, but until now
 * nothing gateway-side checked them — the bundled `photo-ocr` handler's
 * `canonicalRegions` drops an out-of-bounds box before it ever calls this
 * command, but that check lives in a read-only bundled file, not at the
 * write boundary. `enrich.upsert_faces` already rejects a face box outside
 * its asset; this mirrors that so validation lives at the one gateway-side
 * staged write, not scattered across every caller (issue #731). Unlike a
 * face — which IS its box — a text region's box is an annotation on top of
 * real text, so an out-of-bounds box is dropped rather than failing the
 * whole write: the text survives, and an absent box (like an absent
 * confidence) is never invented as `[0,0,0,0]`.
 */
function dropOutOfBoundsRegions(
  ctx: HandlerCtx,
  contentId: string,
  regions: ExtractedTextRegion[]
): ExtractedTextRegion[] {
  const asset = ctx.db
    .prepare("SELECT width, height FROM media_media_asset WHERE content_id = ?")
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

/**
 * Shared canonical derivative writer for reviewed local OCR and enrichers.
 *
 * A REWRITE (an OCR/transcript model bump correcting the same content_id's
 * text) gets a FRESH `derivative_id` rather than an in-place UPDATE.
 * `embed-text`'s bounded cursor walks `derivative_id > cursor`: an in-place
 * update would leave the row's id behind an already-advanced cursor, so the
 * rewritten text would never re-enter the embedding sweep and semantic
 * search would keep serving vectors of the stale text forever (issue #731).
 * A fresh, strictly-later id (derivative ids are UUIDv7, so lexicographic
 * order is creation order) re-enters that sweep exactly once. The row's
 * logical identity is `(content_id, variant)`, enforced by the table's own
 * UNIQUE constraint — nothing outside this module keys off `derivative_id`
 * surviving a rewrite (it is a bare primary key, never a foreign key).
 */
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

/**
 * THE TRIAGE VERB (issue #712). One answer to one proposal, discriminated on
 * `answer` — not three commands that each write a different corner of the
 * same row.
 *
 * WHY THE `confirm_face` / `reject_face` PAIR IS GONE RATHER THAN KEPT BESIDE
 * THIS. Between them they could express two of the three answers a member
 * actually gives, and a review queue needs all three to ever be finishable:
 *
 *   - `confirm` REQUIRED a party_id, so "yes, I looked at this stranger's
 *     face and I am deliberately not naming it" had nowhere to land. The
 *     member's only exit was Skip, which writes nothing — so every skipped
 *     face came back on the next load, for ever.
 *   - `reject` DELETED the row. A deletion is not a state: nothing was left
 *     to say "the owner said no", nothing to count, and nothing standing in
 *     the enricher's way when it next proposed the same face.
 *
 * Both were also the same act — the owner answering a derived proposal — so
 * keeping a thin delegate for each would have left three registered verbs and
 * three app actions writing one column. `media_face_region.review_state` is
 * the state; this is the only verb that writes it.
 *
 * THE UNION IS ENFORCED, NOT DOCUMENTED. `confirm` carries a `party_id`;
 * `reject` and `dismiss` must not. gateway/json-schema.ts is a deliberate
 * JSON-Schema SUBSET with no `oneOf`, so the pairing rides a precondition
 * (declarative, journaled as a check row, and the member gets the sentence)
 * rather than an undeclarable schema branch — the same choice
 * `enrich.request_enrichment` makes just below for its own conditional field.
 */
const ANSWER_FACE_PROPOSAL: CommandDefinition = {
  name: "media.answer_face_proposal",
  ownerSchema: "media",
  inputSchema: {
    type: "object",
    required: ["region_id", "answer"],
    additionalProperties: false,
    properties: {
      region_id: { type: "string", minLength: 1 },
      /** The discriminant (protocol.md C3): one clear field, three members. */
      answer: { type: "string", enum: ["confirm", "reject", "dismiss"] },
      /** `confirm` only — who the face is. See the precondition below. */
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
      // The union rule, in one predicate: `confirm` names a party that exists
      // in this vault; `reject` and `dismiss` name none at all. An optional
      // input binds as NULL here (contract.ts), which is what lets one
      // condition branch on the discriminant instead of two conflicting ones.
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
  // Retry-safe, and NOT `once`: answering the same region twice is how a
  // member corrects themself ("that was not Ana after all"), so the second
  // answer must land rather than be refused as a replay.
  idempotency: "retry-safe",
  // Low by design: this curates DERIVED proposals — the same class as
  // captioning (media.update_asset) — so the in-app loop stays live under the
  // app ceiling instead of parking every click.
  risk: "low",
  handler: answerFaceProposal,
};

/** The three answers, keyed by discriminant — a table, not a branch chain
 *  (coding-standards.md), so a fourth answer is one row rather than an edit
 *  to every site that reads the verb. `keepsParty` is the invariant the DDL
 *  also enforces: only proposed and confirmed regions carry a party. */
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
  // The confirmer is the acting party — the owner when an app or a device
  // calls. Only a confirm has one, and the DDL refuses the pair coming apart.
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
      // Per-class standing consent (issue #310 C3): which derived-data
      // classes the trust covers. Omitted = all classes (a full grant);
      // an array narrows it — everything else stages for review.
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
  // The owner's standing-consent lever (issue #306 Tier 4): widening a
  // connection to auto-publish is a consent-state change — a proposal PARKS.
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
      // `manual` (issue #352 phase 3/4): an owner-driven on-demand ask from
      // an app — "detect faces now" — distinct from a passive search-miss
      // or on-view signal.
      reason: { type: "string", enum: ["search-miss", "on-view", "manual"] },
      detail: { type: "string" },
      // CONSENT SCOPE (see schema/enrich.ts `capability`): which enricher
      // this ask is for. Required for `manual` — an owner's "detect faces
      // now" must not read as consent for captioning, screenshot OCR and
      // every other enabled enricher, which is exactly what an untagged row
      // used to mean.
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
    // The DDL enforces this too; refusing here buys the caller a sentence
    // instead of a CHECK-constraint stack trace.
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
    return { request_id: requestId };
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
      // Which version of the SOURCE the vector was computed from — e.g.
      // `embed-text`'s source `core_content_derivative.derivative_id`. Lets a
      // caller distinguish "this target's embedding is current" from "the
      // model is current but the source was rewritten since" (issue #731):
      // model-only staleness checks miss a same-model text rewrite.
      // Optional because `embed-image` has no comparable versioned source —
      // its target IS the asset it reads bytes from.
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
      sql: "SELECT count(*) AS n FROM media_media_asset WHERE asset_id = :asset_id AND deleted_at IS NULL",
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
      .prepare("SELECT width, height FROM media_media_asset WHERE asset_id = ?")
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
      targetType: "media.media_asset",
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

/** The vault owner's party — apps and device callers act as the owner. */
function ownerPartyId(ctx: HandlerCtx): string {
  const owner = ctx.db
    .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
    .get() as { owner_party_id: string | null } | undefined;
  if (!owner?.owner_party_id) throw new Error("vault has no owner");
  return owner.owner_party_id;
}

export function registerEnrichCommands(gateway: Gateway): void {
  gateway.registerCommand(SET_EXTRACTED_TEXT);
  gateway.registerCommand(ANSWER_FACE_PROPOSAL);
  gateway.registerCommand(SET_CONNECTION_TRUST);
  gateway.registerCommand(REQUEST_ENRICHMENT);
  gateway.registerCommand(UPSERT_EMBEDDING);
  gateway.registerCommand(MARK_REQUESTS_DRAINED);
  gateway.registerCommand(UPSERT_FACES);
  gateway.registerCommand(REBUILD_FACE_CLUSTERS);
}
