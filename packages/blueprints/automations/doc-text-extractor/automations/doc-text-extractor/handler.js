/**
 * Document text (issue #299 phase 1) — the doc enricher.
 *
 * Walks content items forward from a cursor (UUIDv7 ids = time order) and,
 * for each binary document:
 *   - no `text` derivative but a preview/thumb exists → one bounded vision
 *     turn transcribes it (OCR) and `core.set_extracted_text` writes the
 *     text derivative — the #296 FTS triggers index the PARENT document
 *     in-transaction, so the scan becomes searchable the same instant;
 *   - a `text` derivative exists → one bounded turn summarizes it, staged
 *     as a machine annotation on the `enrichment.doctext` connection.
 *
 * A binary document with NEITHER text nor preview is honestly "not
 *  enrichable yet" (issue #299 decision: derivatives egress, never
 * originals — server-side preview codecs are the #296 plug-in seam).
 *
 * Deterministic: cursor in ctx.state, ids derived from content ids,
 * re-runs re-stage the same rows and the spine's dedup skips them.
 *
 * ENGINE PROFILES (issue #807, Wave 5). Unlike `photo-ocr`, this enricher has
 * no bundled deterministic engine to fall back to — extracting text from a
 * scan IS a model turn here, which is why it declares `lane: "gateway"` and
 * ships disabled. So its two variants are not "local vs remote": they are
 * "whatever engine this vault runs automations on" (the built-in profile,
 * unchanged since #299) versus "the engine the member bound `doc-text` to",
 * which is pinned, prompt-revisioned, and STAMPED — the text derivative gets
 * an `enrich_derivation` row naming the profile, model and prompt revision
 * that produced it, so a member can tell two engines' transcriptions apart
 * and re-derive one without touching the other. The fire path selects the
 * variant from policy (`automation/fire/fire.ts`); nothing here chooses.
 */

const BATCH = 6;
/**
 * The byte budget for one page image handed to the transcription turn
 * (#1014, R10). `ctx.vault.content`'s DEFAULT is 1 MiB and this handler passed
 * nothing, so a perfectly ordinary 1.5 MB device preview came back
 * `too-large`, the turn threw, and — because the cursor is written after the
 * loop — the SAME document was first in every later batch. One poisoned item
 * blocked every later one, forever. Four MiB is the hard ceiling the agent
 * content surface allows (`AGENT_CONTENT_HARD_MAX_BYTES`).
 */
const VISUAL_MAX_BYTES = 4 * 1024 * 1024;
/** Failures one document is given before this recipe declines it. */
const MAX_TARGET_FAILURES = 3;
/** The prompt revision this handler's transcription prompt is at. */
const PROMPT_REV = "doc-text-v1";
/** `BUILT_IN_PROFILE` in packages/vault/src/enrich/derivation.ts, restated. */
const BUILT_IN_PROFILE = "built-in";

const OCR_SCHEMA = {
  type: "object",
  required: ["text"],
  additionalProperties: false,
  properties: {
    text: {
      type: "string",
      description:
        "The document text, transcribed faithfully. Empty string if unreadable.",
    },
  },
};

const SUMMARY_SCHEMA = {
  type: "object",
  required: ["summary"],
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      description:
        "One factual paragraph: what this document is, key parties, amounts, dates.",
    },
  },
};

export default async function handler({ ctx, log }) {
  // The engine the policy cascade selected for `doc-text`, as the fire path
  // resolved it. `deterministic` is the pre-#807 behaviour, byte for byte.
  const delegateStep = ctx.input?.variant === "delegate";
  const profileId = ctx.input?.profileId ?? BUILT_IN_PROFILE;
  const pinnedModel = ctx.input?.delegateModel;
  if (delegateStep && !pinnedModel)
    throw new Error("delegate document text requires an explicit pinned model");
  // The prompt text belongs to this handler, so a profile may only pin a
  // revision it actually ships — stamping one we did not send would make the
  // derivation ledger lie.
  const pinnedPromptRev = ctx.input?.promptRev;
  if (delegateStep && pinnedPromptRev && pinnedPromptRev !== PROMPT_REV)
    throw new Error(
      `delegate document text: the engine profile pins prompt revision "${pinnedPromptRev}", but this handler ships "${PROMPT_REV}"`
    );
  const cursor = (await ctx.state.get("cursor")) ?? "";
  const derivativeCursor = (await ctx.state.get("derivativeCursor")) ?? "";
  const now = ctx.now;
  // A plugged-in device gets the first chance at PDF.js text. Do not move
  // the backlog cursor past a live lease: after completion the text variant
  // is summarized here; after expiry this gateway backstop takes over.
  const leased = await ctx.vault.read({
    entity: "enrich.request",
    where: [
      // Real column names: `enrich_request` carries `target_type`/`target_id`,
      // never `entity_type`/`entity_id`. The old names are not columns of the
      // table, so this read threw `unknown column` and `deviceOwned` was
      // always empty — the gateway backstop ran straight over live device
      // leases instead of yielding to them.
      { column: "target_type", op: "eq", value: "core.content_item" },
      { column: "required_capability", op: "eq", value: "pdfText" },
      { column: "drained_at", op: "is-null" },
      { column: "lease_expires_at", op: "gt", value: now },
    ],
    limit: 100,
  });
  const deviceOwned = new Set(
    (leased.rows ?? []).map((request) => request.target_id)
  );
  const read = await ctx.vault.read({
    entity: "core.content_item",
    where: [
      { column: "content_id", op: "gt", value: cursor },
      { column: "deleted_at", op: "is-null" },
    ],
    orderBy: { column: "content_id", dir: "asc" },
    limit: BATCH,
  });
  const items = read.rows ?? [];
  // Originals and derivatives have independent clocks. Following only the
  // content-item cursor permanently misses a preview/text row that arrives
  // after its parent was skipped, so tail the typed derivative stream too.
  const lateRead = await ctx.vault.read({
    entity: "core.content_derivative",
    where: [
      { column: "derivative_id", op: "gt", value: derivativeCursor },
      { column: "variant", op: "in", value: ["text", "preview", "thumb"] },
    ],
    orderBy: { column: "derivative_id", dir: "asc" },
    limit: BATCH,
  });
  const late = (lateRead.rows ?? []).filter(
    (row) =>
      typeof row.derivative_id === "string" &&
      typeof row.content_id === "string"
  );
  if (items.length === 0 && late.length === 0) {
    return { summary: "no new documents — all readable and summarized" };
  }

  /**
   * The first rung of the visual ladder whose bytes fit the budget, or null.
   * The check is a real read: a `too-large` verdict is a fact about the rung's
   * size, and guessing it from the derivative row would be a second notion of
   * the same ceiling.
   */
  const firstReadableVariant = async (contentId, preferred) => {
    const ladder = preferred === "preview" ? ["preview", "thumb"] : ["thumb"];
    for (const variant of ladder) {
      const probe = await ctx.vault.content({
        contentId,
        variant,
        maxBytes: VISUAL_MAX_BYTES,
      });
      if (probe?.status === "ok") return variant;
    }
    return null;
  };
  /** Count one failure against a document; true once the walk should move on. */
  const declineTarget = async (contentId, input) => {
    try {
      const outcome = await ctx.vault.invoke({
        command: "enrich.record_target_failure",
        input: {
          capability: "doc-text",
          target_type: "core.content_item",
          target_id: contentId,
          max_failures: MAX_TARGET_FAILURES,
          ...(input.error === undefined
            ? {}
            : { error: String(input.error).slice(0, 2000) }),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.permanent === undefined
            ? {}
            : { permanent: input.permanent }),
        },
      });
      const output = outcome?.output ?? outcome;
      return output?.declined === true;
    } catch {
      return false;
    }
  };

  const summaryRows = [];
  let ocred = 0;
  let summarized = 0;
  let skipped = 0;
  let lastSeen = cursor;
  let lastDerivative = derivativeCursor;
  const processed = new Set();
  const processItem = async (item) => {
    const mediaType = String(item.media_type ?? "");
    // Inline text items already feed FTS whole; skip non-documents.
    if (mediaType.startsWith("text/")) return;
    const derivatives = await ctx.vault.read({
      entity: "core.content_derivative",
      where: [{ column: "content_id", op: "eq", value: item.content_id }],
      limit: 5,
    });
    const variants = (derivatives.rows ?? []).map((d) => d.variant);
    const hasText = variants.includes("text");
    const visual = variants.includes("preview")
      ? "preview"
      : variants.includes("thumb")
        ? "thumb"
        : null;

    if (!hasText && visual) {
      // FALL BACK DOWN THE LADDER, THEN GIVE UP DURABLY (#1014, R10). A
      // preview past the ceiling is not a reason to lose the document: the
      // `thumb` rung is smaller by construction and legible enough for a
      // transcription turn. Only when NEITHER fits is the target declined —
      // and `too-large` is permanent for that target, because trying the same
      // bytes against the same ceiling twice more cannot end differently.
      const readable = await firstReadableVariant(item.content_id, visual);
      if (readable === null) {
        await declineTarget(item.content_id, {
          reason: "too-large",
          error: `no ${visual}/thumb rung fits within ${VISUAL_MAX_BYTES} bytes`,
          permanent: true,
        });
        skipped += 1;
        return;
      }
      // OCR: transcribe what the preview shows, then write the text
      // derivative — the parent document becomes searchable in the same
      // transaction (issue #296 FTS rule).
      const out = await ctx.delegate({
        prompt:
          "The attached image is a page of a document. Transcribe ALL legible text faithfully, " +
          "preserving reading order. Return an empty string if nothing is legible.",
        json: OCR_SCHEMA,
        content: [
          {
            contentId: item.content_id,
            variant: readable,
            maxBytes: VISUAL_MAX_BYTES,
          },
        ],
      });
      const text = out && typeof out.text === "string" ? out.text.trim() : "";
      // Provenance is the delegate variant's whole added value: a pinned
      // engine's answer is stamped with the ACP-CONFIRMED model identity —
      // never the pinned id, which is only what was asked for — plus the
      // profile and prompt revision, so the row says who produced this text.
      let confirmedModel;
      if (delegateStep) {
        confirmedModel =
          out && typeof out.__centraidModel === "string"
            ? out.__centraidModel
            : null;
        if (!confirmedModel)
          throw new Error(
            "delegate document text returned no ACP-confirmed model identity"
          );
      }
      if (text.length > 0) {
        await ctx.vault.invoke({
          command: "core.set_extracted_text",
          input: {
            content_id: item.content_id,
            text,
            ...(delegateStep
              ? {
                  capability: "doc-text",
                  model: confirmedModel,
                  prompt_rev: PROMPT_REV,
                  ...(profileId === BUILT_IN_PROFILE
                    ? {}
                    : { profile: profileId }),
                }
              : {}),
          },
        });
        ocred += 1;
      } else {
        skipped += 1;
      }
      return;
    }

    if (hasText) {
      const prior = await ctx.vault.read({
        entity: "sync.external_entity",
        where: [
          {
            column: "external_id",
            op: "eq",
            value: `${item.content_id}:summary`,
          },
        ],
        limit: 1,
      });
      if ((prior.rows ?? []).length > 0) return;
      // Summarize from the text variant — no bytes leave beyond the
      // already-extracted text, size-bounded by the content surface.
      const out = await ctx.delegate({
        prompt:
          "Summarize the attached document text in ONE factual paragraph: what it is, the key " +
          "parties, amounts and dates. No speculation.",
        json: SUMMARY_SCHEMA,
        content: [{ contentId: item.content_id, variant: "text" }],
      });
      const summary =
        out && typeof out.summary === "string" ? out.summary.trim() : "";
      if (summary.length > 0) {
        summaryRows.push({
          entity_type: "knowledge.annotation",
          external_id: `${item.content_id}:summary`,
          payload: {
            target_type: "core.content_item",
            target_id: item.content_id,
            body: summary,
          },
        });
        summarized += 1;
      }
      return;
    }

    // Neither text nor a visual derivative: not enrichable yet.
    skipped += 1;
    log.info(
      `content ${item.content_id}: no text or preview derivative — not enrichable yet`
    );
  };

  /**
   * ONE POISONED DOCUMENT DOES NOT BLOCK EVERY LATER ONE (#1014, R10). A throw
   * inside `processItem` skipped the cursor write below, so the same document
   * led every later batch. Under the cap the walk parks on it (nothing is
   * lost); at the cap it is declined durably and the cursor moves past it.
   * Returns true when the caller may advance its watermark.
   */
  const runItem = async (item) => {
    try {
      await processItem(item);
      return true;
    } catch (error) {
      const declined = await declineTarget(item.content_id, {
        reason: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      if (declined) {
        skipped += 1;
        log.info(
          `content ${item.content_id}: giving up after repeated failures`
        );
        return true;
      }
      log.info(
        `content ${item.content_id}: document text failed, retrying next tick`
      );
      return false;
    }
  };

  // Derivative rows are processed in their own order and their cursor moves
  // only after the owning content was handled. A live device lease pins this
  // stream exactly like it pins the new-content stream.
  for (const row of late) {
    if (deviceOwned.has(row.content_id)) break;
    if (!processed.has(row.content_id)) {
      const advanced = await runItem({
        content_id: row.content_id,
        media_type: "application/octet-stream",
      });
      processed.add(row.content_id);
      if (!advanced) break;
    }
    lastDerivative = row.derivative_id;
  }
  for (const item of items) {
    if (deviceOwned.has(item.content_id)) break;
    if (processed.has(item.content_id)) {
      lastSeen = item.content_id;
      continue;
    }
    const advanced = await runItem(item);
    processed.add(item.content_id);
    if (!advanced) break;
    lastSeen = item.content_id;
  }

  if (summaryRows.length > 0) {
    await ctx.vault.invoke({
      command: "sync.stage_rows",
      input: { kind: "enrichment.doctext", label: "docs", rows: summaryRows },
    });
  }
  await ctx.state.set("cursor", lastSeen);
  await ctx.state.set("derivativeCursor", lastDerivative);
  return {
    summary: `OCRed ${ocred}, summarized ${summarized}, skipped ${skipped}`,
    output: { ocred, summarized, skipped },
  };
}
