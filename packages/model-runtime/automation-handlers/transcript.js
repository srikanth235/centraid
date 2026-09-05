/* oxlint-disable no-await-in-loop -- local ASR is intentionally serial so one fire has a strict native-memory ceiling */
import {
  TRANSCRIPT_MODEL_ID,
  transcript,
  transcriptWeightsPresent,
} from "../src/capabilities/transcript.js";

const BATCH = 2;
// Matches the existing ctx.vault.content original-audio/video ceiling. FFmpeg
// separately caps decompressed duration, so both compressed and expanded work
// remain bounded.
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

let transcribe = transcript;
let weightsPresent = transcriptWeightsPresent;

/** Test-only replacement retained in the generated bundle. */
export function setTranscriptRuntimeForTests(runtime) {
  transcribe = runtime?.transcribe ?? transcript;
  weightsPresent = runtime?.weightsPresent ?? transcriptWeightsPresent;
}

function modelAvailable() {
  return weightsPresent() ? TRANSCRIPT_MODEL_ID : null;
}

async function seedCursor(ctx, model) {
  const latest = await ctx.vault.read({
    entity: "media.asset",
    where: [
      { column: "kind", op: "in", value: ["audio", "video"] },
      { column: "deleted_at", op: "is-null" },
    ],
    orderBy: { column: "asset_id", dir: "desc" },
    limit: 1,
  });
  const asset = latest.rows?.[0];
  if (!asset) return "";
  const stamps = await ctx.vault.read({
    entity: "enrich.derivation",
    where: [
      { column: "target_id", op: "eq", value: asset.content_id },
      { column: "variant", op: "eq", value: "transcript" },
    ],
    limit: 1,
  });
  return stamps.rows?.[0]?.model === model ? asset.asset_id : "";
}

export default async function handler({ ctx, log }) {
  const model = modelAvailable();
  if (!model)
    return {
      summary: "transcript skipped — automation model assets unavailable",
    };
  const priorModel = await ctx.state.get("model");
  if (priorModel !== model) {
    await ctx.state.set(
      "cursor",
      priorModel === undefined ? await seedCursor(ctx, model) : ""
    );
    await ctx.state.set("model", model);
  }
  const cursor = (await ctx.state.get("cursor")) ?? "";
  const read = await ctx.vault.read({
    entity: "media.asset",
    where: [
      { column: "asset_id", op: "gt", value: cursor },
      { column: "kind", op: "in", value: ["audio", "video"] },
      { column: "deleted_at", op: "is-null" },
    ],
    orderBy: { column: "asset_id", dir: "asc" },
    limit: BATCH,
  });
  let derived = 0;
  let skipped = 0;
  for (const asset of read.rows ?? []) {
    const stamps = await ctx.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: asset.content_id },
        { column: "variant", op: "eq", value: "transcript" },
      ],
      limit: 1,
    });
    if (stamps.rows?.[0]?.model === model) {
      skipped += 1;
      continue;
    }
    const content = await ctx.vault.content({
      contentId: asset.content_id,
      variant: "original",
      maxBytes: MAX_SOURCE_BYTES,
    });
    if (content?.status === "too-large") {
      // A permanent, deterministic fact about this asset — no retry ever
      // shrinks it below MAX_SOURCE_BYTES, so treat it like an honest
      // "nothing to transcribe" rather than an infrastructure failure:
      // skip and let the cursor advance past it. Anything else non-ok
      // (missing blob, transient store error) falls through to the throw
      // below so the run fails and the cursor holds for a retry.
      skipped += 1;
      log.info(
        `asset ${asset.asset_id}: original exceeds the ${MAX_SOURCE_BYTES}-byte transcription ceiling`
      );
      continue;
    }
    if (content?.status !== "ok" || content.kind !== "bytes")
      throw new Error(
        `asset ${asset.asset_id}: bounded original is unavailable`
      );
    const result = await transcribe({
      id: asset.content_id,
      bytes: content.base64,
      mediaType: content.mediaType,
    });
    if (!result || result.error)
      throw new Error(
        result?.error ?? `asset ${asset.asset_id}: ASR returned no result`
      );
    const text = typeof result.text === "string" ? result.text.trim() : "";
    if (!text) {
      skipped += 1;
      log.info(`asset ${asset.asset_id}: no speech detected`);
      continue;
    }
    await ctx.vault.invoke({
      command: "core.set_extracted_text",
      input: {
        content_id: asset.content_id,
        text,
        variant: "transcript",
        capability: "transcript",
        model,
      },
    });
    derived += 1;
  }
  const last = read.rows?.at(-1)?.asset_id;
  if (last) await ctx.state.set("cursor", last);
  return {
    summary: `transcribed ${derived}; skipped ${skipped}; bounded batch ${read.rows?.length ?? 0}/${BATCH}`,
    output: {
      derived,
      skipped,
      model,
      rearm: (read.rows?.length ?? 0) === BATCH,
    },
  };
}
