// The photo OCR spec (issue #724 W4): what the generic capability sweep needs
// to turn a photograph's own preview bytes into searchable text.
//
// PHOTOS DOMAIN, AND WHY OCR NEEDS NO SEPARATE CONSENT FROM THE PIXELS
// THEMSELVES. `policyDomain: "photos"` gates this spec on the SAME
// `enrich_policy` tier an owner already set for their photo library — there
// is no second knob to turn off "read the text in my photos" while leaving
// "look at my photos" on, because an owner who consented to the gateway
// deriving *anything* from a photograph's pixels already consented to this:
// the text visible in a photo IS pixels, read differently. `faces` is the
// capability this looks like and is not — a face asserts an IDENTITY, which
// is why faces carries its own separate consent gate even at the SAME domain
// tier. OCR names nothing and no one; it reads what the photograph already
// shows in plain sight.
//
// TARGET IS THE CONTENT ITEM, NOT THE PHOTOS-APP ASSET. The text derivative
// this spec writes hangs off `core_content_derivative`, which is keyed by
// `content_id` — the canonical-bytes row, not the `media_media_asset` row
// that wraps it for the Photos app. `media_media_asset.content_id` is
// UNIQUE, so the mapping is exactly 1:1, and keying the derivation stamp by
// content item lets the same stamp, the same command and the same FTS
// triggers serve documents (already wired), photos (this spec) and audio/
// video (`transcript-sweep.ts`) alike — one text plane, not three.
//
// DERIVATIVES, NEVER ORIGINALS (issue #721 mandate, restated because it is
// the rule most worth re-breaking a habit over). The bytes sent to the
// service are the asset's preview/thumb rung, exactly as `embedding-sweep`
// reads them: preview first for the detail a text-recognition model wants,
// thumb as the fallback, and an asset with neither rung is SKIPPED rather
// than read from its original. An owner's full-resolution photograph is
// never uploaded anywhere by this pass.
//
// WHY THE COMMAND PIPELINE, NOT A RAW INSERT. `core.set_extracted_text`
// (`packages/vault/src/commands/enrich.ts`) already owns the UPDATE-or-INSERT
// into `core_content_derivative`, the FTS-refresh triggers that make the text
// searchable, the postcondition that proves the row landed, and the receipt
// that makes the write auditable — the same machinery every other
// content-derivative writer in this ontology rides, and duplicating it here
// in raw SQL would be a second, driftable copy of that logic. Calling
// `gateway.invoke` a SECOND time from inside this sweep's own open
// transaction is safe ON PURPOSE: `execution.ts`'s
// `beginInvocationTransaction` checks `db.isTransaction` and opens a
// SAVEPOINT instead of a fresh `BEGIN` exactly for a caller like this one, so
// the command's write, the derivation stamp and the request drain still
// commit — or roll back — together as one unit.
//
// HONEST EMPTY (issue #299's rule, restated for OCR specifically). A
// photograph with no legible text is not a failure — most photographs have
// none — so an empty `regions` array (or one whose regions carry no text at
// all) still stamps, so the backfill does not loop over the same asset
// forever, but writes NO text derivative: `core.set_extracted_text` refuses
// an empty string, and fabricating a placeholder would make an empty
// photograph indistinguishable from one whose text failed to derive.
//
// READING ORDER IS TOP-TO-BOTTOM, THEN LEFT-TO-RIGHT. The wire contract makes
// no promise about region order, so before joining region text into one
// string this spec sorts a COPY by `box[1]` (y) then `box[0]` (x) — the
// simplest approximation of how a person reads a photographed sign or page,
// and simplicity is the point: this feeds a search index, not a layout
// engine. The STAMPED payload keeps the service's own region order (and
// every box/confidence) exactly as answered — the display choice above never
// touches what is recorded as having been derived.

import type { Credential, Gateway, VaultDb } from "@centraid/vault";

import { selectOpenRequests } from "./capability-sweep.js";
import type {
  CapabilitySweepApply,
  CapabilitySweepBacklog,
  CapabilitySweepSpec,
  CapabilitySweepTarget,
} from "./capability-sweep.js";
import { ocrReadingOrderText } from "./wire-shapes.js";

/** The logical entity OCR text is keyed by — see the header. */
const TARGET_TYPE = "content_item";

/**
 * The `enrich_request` tokens an OCR ask carries. `ocr` is the on-device
 * lease lane's `required_capability` token; `text` is the matching
 * `contribution_variant` token — unlike embedding's queue vocabulary, OCR's
 * two enums do not share one word for this capability, so both must be
 * listed for `selectOpenRequests`'s single shared column list to catch
 * either kind of queued ask.
 */
const REQUEST_CAPABILITIES = ["ocr", "text"] as const;

interface DerivativeRow {
  sha256: string;
  media_type: string;
}

interface AssetDimensions {
  width: number | null;
  height: number | null;
}

function writeOcrText(
  gateway: Gateway,
  ownerCredential: Credential,
  input: CapabilitySweepApply<"ocr">
): unknown {
  const text = ocrReadingOrderText(input.result.regions);
  // Honest empty (see header): no legible text writes no derivative, but the
  // stamp below still lands so this content item is not re-scanned forever.
  if (text.length > 0) {
    const outcome = gateway.invoke(ownerCredential, {
      command: "core.set_extracted_text",
      input: { content_id: input.target.id, text, variant: "text" },
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
  // The stamp's payload: the service's own regions, order and all — enough
  // for an operator reading a stuck library to see WHAT was derived without
  // a second copy of the text itself.
  return { regions: input.result.regions };
}

/**
 * Photographs → the content item's `text` derivative, on the shared sweep. A
 * FACTORY, not a plain spec object like `EMBEDDING_SWEEP_SPEC`: `apply` needs
 * to invoke `core.set_extracted_text` through the real command pipeline (see
 * the header), which needs the vault's `Gateway` and the credential to
 * invoke it as — both live on the `VaultPlane` that wires this sweep in, not
 * on the bare `VaultDb` the generic sweep hands every spec.
 */
export function createOcrSweepSpec(
  gateway: Gateway,
  ownerCredential: Credential
): CapabilitySweepSpec<"ocr"> {
  return {
    capability: "ocr",
    policyDomain: "photos",
    targetType: TARGET_TYPE,
    variant: "text",

    selectBacklog: (db: VaultDb, input): CapabilitySweepBacklog => {
      // Owner asks first (issue #299 phase 5), same shared half every spec
      // uses.
      const requests = selectOpenRequests(db, {
        targetType: TARGET_TYPE,
        capabilityNames: REQUEST_CAPABILITIES,
        limit: input.limit,
        now: input.now,
      });

      const backfillLimit = Math.max(0, input.limit - requests.order.length);
      // Backfill: photo assets whose content item carries no CURRENT-model
      // 'text' stamp — either never derived, or derived under a superseded
      // model. `enrich_derivation` (not `core_content_derivative`) is the
      // join target because it is the one table that knows WHICH model
      // produced a row (see schema/enrich.ts's header).
      const backfill = (
        db.vault
          .prepare(
            `SELECT a.content_id AS content_id
               FROM media_media_asset a
               LEFT JOIN enrich_derivation d
                 ON d.target_type = ? AND d.target_id = a.content_id
                    AND d.variant = 'text' AND d.model = ?
              WHERE a.deleted_at IS NULL AND a.kind = 'photo'
                AND d.derivation_id IS NULL
              ORDER BY a.content_id
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
      // Preview before thumb — see the header. `sha256 IS NOT NULL` excludes
      // the inline text derivatives (phash/thumbhash share this table).
      const row = db.vault
        .prepare(
          `SELECT d.sha256 AS sha256, d.media_type AS media_type
             FROM core_content_derivative d
            WHERE d.content_id = ?
              AND d.variant IN ('preview','thumb') AND d.sha256 IS NOT NULL
            ORDER BY CASE d.variant WHEN 'preview' THEN 0 ELSE 1 END
            LIMIT 1`
        )
        .get(target.id) as DerivativeRow | undefined;
      if (!row) return null;
      // Local hit first; a remote-only derivative reads through custody at
      // indexing pace, exactly as the embedding sweep does.
      const bytes =
        db.blobs.getSync(row.sha256) ?? (await db.blobs.open(row.sha256));
      if (!bytes) return null;
      // Declared so boxes come back in the ORIGINAL photo's pixel space
      // (service-client.ts) rather than the preview's downscaled one.
      const dims = db.vault
        .prepare(
          `SELECT width, height FROM media_media_asset WHERE content_id = ?`
        )
        .get(target.id) as AssetDimensions | undefined;
      return {
        id: target.id,
        mediaType: row.media_type,
        bytes: bytes.toString("base64"),
        ...(dims?.width ? { originalWidth: dims.width } : {}),
        ...(dims?.height ? { originalHeight: dims.height } : {}),
      };
    },

    apply: (db, input) => writeOcrText(gateway, ownerCredential, input),
  };
}
