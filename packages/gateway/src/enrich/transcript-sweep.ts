// The transcript spec (issue #724 W6): what the generic capability sweep
// needs to turn an audio/video content item's own bytes into a searchable
// transcript.
//
// DOCS DOMAIN, BY ELIMINATION. A transcript's whole point is to make a
// recording's WORDS findable the same way a document's text is — the same
// `core.set_extracted_text` verb, the same `core_content_derivative` row,
// the same FTS triggers. Nothing about a voice memo or a home video argues
// for gating it on the PHOTOS tier (that tier is about pixels — the photo
// sweeps read a photograph's own bytes, and a recording is not one), so this
// spec rides `policyDomain: "docs"`, the domain every other text-extraction
// consumer in this ontology already answers to. If a future release wants a
// third, media-specific tier this is the one line that moves.
//
// TARGET IS THE CONTENT ITEM (same convention as `ocr-sweep.ts`): the
// transcript hangs off `core_content_derivative`, keyed by `content_id`, so
// the identical stamp/command/FTS-trigger plane serves photos, documents and
// recordings alike.
//
// THE ONE DELIBERATE DEPARTURE FROM THE PHOTO SWEEPS: ORIGINAL BYTES. Every
// photo-domain spec (`embedding-sweep.ts`, `ocr-sweep.ts`) reads a PREVIEW or
// THUMB derivative and refuses to touch an owner's full-resolution original —
// that rule exists because a photograph's preview already carries everything
// a vision model needs, so there is no reason to ever hand over the original.
// Audio has no such stand-in: a "preview" of a recording is not a smaller
// version of the same words, it is missing words, so transcribing anything
// but the real bytes would silently produce an incomplete transcript. This
// spec therefore reads `core_content_item.sha256` — the ORIGINAL — the same
// read `device-work-routes.ts`'s on-device lease lane relies on a device
// fetching for the identical reason (poster/pdfText/previews's device-side
// counterparts already need real bytes to do real work). A byte ceiling
// (`MAX_ORIGINAL_BYTES`) bounds the blast radius of that one exception: a
// multi-hour, multi-gigabyte recording is skipped rather than read whole
// into memory and POSTed to a local service.
//
// HONEST EMPTY, ONE MORE TIME. A recording the service could not transcribe
// (silence, an unrecognized language, static) still stamps — so the backfill
// does not loop over it forever — but writes no derivative: an empty string
// fails `core.set_extracted_text`'s own schema, and a fabricated placeholder
// would make "nothing to transcribe" indistinguishable from "transcription
// failed".

import type { Credential, Gateway, VaultDb } from "@centraid/vault";

import { selectOpenRequests } from "./capability-sweep.js";
import type {
  CapabilitySweepApply,
  CapabilitySweepBacklog,
  CapabilitySweepSpec,
  CapabilitySweepTarget,
} from "./capability-sweep.js";

/** The logical entity transcripts are keyed by — see the header. */
const TARGET_TYPE = "content_item";

/** `transcript` names both the lease-lane and the queue-tag column alike. */
const REQUEST_CAPABILITIES = ["transcript"] as const;

/**
 * A generous ceiling, not a budget: long enough for hours of speech, short
 * enough that one recording can never blow up a sweep's memory or a local
 * service's request body. See the header on why ORIGINAL bytes are read at
 * all — this is what keeps that exception bounded.
 */
const MAX_ORIGINAL_BYTES = 200 * 1024 * 1024;

interface ContentItemRow {
  sha256: string;
  media_type: string;
  byte_size: number;
}

function writeTranscriptText(
  gateway: Gateway,
  ownerCredential: Credential,
  input: CapabilitySweepApply<"transcript">
): unknown {
  const text = input.result.text;
  // Honest empty (see header): nothing recognizable writes no derivative,
  // but the stamp below still lands so this content item is not retried
  // forever.
  if (text.length > 0) {
    const outcome = gateway.invoke(ownerCredential, {
      command: "core.set_extracted_text",
      input: { content_id: input.target.id, text, variant: "transcript" },
      purpose: "dpv:ServiceProvision",
    });
    if (outcome.status !== "executed") {
      const reason = "reason" in outcome ? outcome.reason : "no reason given";
      throw new Error(
        `core.set_extracted_text did not execute for content item ${input.target.id}: ` +
          `${outcome.status} (${reason})`
      );
    }
  }
  return input.result.confidence === undefined
    ? {}
    : { confidence: input.result.confidence };
}

/**
 * Audio/video → the content item's `transcript` derivative, on the shared
 * sweep. A FACTORY like `createOcrSweepSpec`, for the identical reason:
 * `apply` invokes `core.set_extracted_text` through the real command
 * pipeline, which needs the vault's `Gateway` and the credential to invoke
 * it as.
 */
export function createTranscriptSweepSpec(
  gateway: Gateway,
  ownerCredential: Credential
): CapabilitySweepSpec<"transcript"> {
  return {
    capability: "transcript",
    policyDomain: "docs",
    targetType: TARGET_TYPE,
    variant: "transcript",

    selectBacklog: (db: VaultDb, input): CapabilitySweepBacklog => {
      const requests = selectOpenRequests(db, {
        targetType: TARGET_TYPE,
        capabilityNames: REQUEST_CAPABILITIES,
        limit: input.limit,
        now: input.now,
      });

      const backfillLimit = Math.max(0, input.limit - requests.order.length);
      // Backfill: audio/video content items with no CURRENT-model
      // 'transcript' stamp — never derived, or derived under a superseded
      // model. Matched on the content item's OWN media_type — a recording
      // need not have a `media_media_asset` row (that table is the Photos
      // app's projection; a voice memo attached elsewhere in the ontology is
      // still a content item with an audio media type).
      const backfill = (
        db.vault
          .prepare(
            `SELECT ci.content_id AS content_id
               FROM core_content_item ci
               LEFT JOIN enrich_derivation d
                 ON d.target_type = ? AND d.target_id = ci.content_id
                    AND d.variant = 'transcript' AND d.model = ?
              WHERE ci.deleted_at IS NULL
                AND (ci.media_type LIKE 'audio/%' OR ci.media_type LIKE 'video/%')
                AND d.derivation_id IS NULL
              ORDER BY ci.content_id
              LIMIT ?`
          )
          .all(TARGET_TYPE, input.model, backfillLimit) as unknown as {
          content_id: string;
        }[]
      ).map((row) => row.content_id);
      const exhausted = backfillLimit > 0 && backfill.length < backfillLimit;

      const targets: CapabilitySweepTarget[] = [
        ...requests.order.map((id) => ({
          id,
          requestIds: requests.byTarget.get(id) ?? [],
        })),
        ...backfill
          .filter((id) => !requests.byTarget.has(id))
          .map((id) => ({ id, requestIds: [] })),
      ];
      return { targets, domainRequestIds: requests.domain, exhausted };
    },

    buildItem: async (db: VaultDb, target: CapabilitySweepTarget) => {
      // ORIGINAL bytes, deliberately — see the header for why this spec is
      // the one exception to "derivatives, never originals".
      const row = db.vault
        .prepare(
          `SELECT sha256, media_type, byte_size FROM core_content_item
            WHERE content_id = ? AND deleted_at IS NULL`
        )
        .get(target.id) as ContentItemRow | undefined;
      if (!row) return null;
      // An honest skip, not a truncated read: a partial transcript of the
      // first N bytes of a recording would be a wrong transcript, not a
      // short one.
      if (row.byte_size > MAX_ORIGINAL_BYTES) return null;
      const bytes =
        db.blobs.getSync(row.sha256) ?? (await db.blobs.open(row.sha256));
      if (!bytes) return null;
      return {
        id: target.id,
        mediaType: row.media_type,
        bytes: bytes.toString("base64"),
      };
    },

    apply: (db, input) => writeTranscriptText(gateway, ownerCredential, input),
  };
}
