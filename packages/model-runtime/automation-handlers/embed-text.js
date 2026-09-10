/* oxlint-disable no-await-in-loop -- bounded vault walks preserve cursor and typed-write order */
import {
  EMBED_MODEL_ID,
  embedText,
  embedWeightsPresent,
} from "../src/capabilities/embed.js";
import { NOT_READY_MAX_TICKS, recordTargetFailure } from "./target-failures.js";

const BATCH = 16;
let infer = embedText;
let weightsPresent = embedWeightsPresent;

export function setEmbedTextRuntimeForTests(runtime) {
  infer = runtime?.infer ?? embedText;
  weightsPresent = runtime?.weightsPresent ?? embedWeightsPresent;
}

function modelAvailable() {
  return weightsPresent() ? EMBED_MODEL_ID : null;
}

function stampMatchesSource(stamp, model, sourceVersion) {
  const stampedSourceVersion =
    typeof stamp?.payload_json === "string"
      ? JSON.parse(stamp.payload_json).source_version
      : stamp?.source_version;
  return stamp?.model === model && stampedSourceVersion === sourceVersion;
}

async function seedCursor(ctx, model) {
  const latest = await ctx.vault.read({
    entity: "core.content_derivative",
    where: [{ column: "variant", op: "in", value: ["text", "transcript"] }],
    orderBy: { column: "derivative_id", dir: "desc" },
    limit: 1,
  });
  const item = latest.rows?.[0];
  if (!item) return "";
  const stamps = await ctx.vault.read({
    entity: "enrich.derivation",
    where: [
      { column: "target_id", op: "eq", value: item.content_id },
      { column: "variant", op: "eq", value: "embedding" },
    ],
    limit: 1,
  });
  return stampMatchesSource(stamps.rows?.[0], model, item.derivative_id)
    ? item.derivative_id
    : "";
}

export default async function handler({ ctx, log }) {
  const model = modelAvailable();
  if (!model)
    return { summary: "text embedding skipped — model assets unavailable" };
  if (typeof ctx.input?.query === "string") {
    const query = ctx.input.query.trim();
    if (!query) throw new Error("text embedding query is empty");
    const result = await infer({ id: "query", text: query });
    if (!result || result.error || !Array.isArray(result.vector))
      throw new Error(result?.error ?? "text embedding returned no vector");
    return {
      summary: "embedded one search query",
      output: { model, vector: result.vector },
    };
  }
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
    entity: "core.content_derivative",
    where: [
      { column: "derivative_id", op: "gt", value: cursor },
      { column: "variant", op: "in", value: ["text", "transcript"] },
    ],
    orderBy: { column: "derivative_id", dir: "asc" },
    limit: BATCH,
  });
  let derived = 0;
  let skipped = 0;
  let notReady = 0;
  // ONE UNAVAILABLE TEXT DOES NOT STOP THE WALK (#1014, B2). Throwing here
  // skipped the cursor write at the tail of the loop, so the SAME derivative
  // was read first on every later tick and nothing after it was ever embedded.
  // The watermark parks on the last item before the first unavailable one and
  // advances past it once the register declines it.
  let watermark = "";
  let parked = false;
  for (const item of read.rows ?? []) {
    const stamps = await ctx.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: item.content_id },
        { column: "variant", op: "eq", value: "embedding" },
      ],
      limit: 1,
    });
    if (stampMatchesSource(stamps.rows?.[0], model, item.derivative_id)) {
      skipped += 1;
      if (!parked) watermark = item.derivative_id;
      continue;
    }
    const content = await ctx.vault.content({
      contentId: item.content_id,
      variant: item.variant,
      maxBytes: 1024 * 1024,
    });
    if (content?.status !== "ok" || content.kind !== "text") {
      const verdict = await recordTargetFailure(ctx, {
        capability: "embed-text",
        targetType: "core.content_item",
        targetId: item.content_id,
        reason: "no-text",
        error: `${item.variant} text is unavailable`,
        maxFailures: NOT_READY_MAX_TICKS,
      });
      if (verdict.declined) {
        skipped += 1;
        if (!parked) watermark = item.derivative_id;
        log.info(
          `content ${item.content_id}: ${item.variant} text never landed`
        );
      } else {
        notReady += 1;
        parked = true;
        log.info(
          `content ${item.content_id}: ${item.variant} text is unavailable`
        );
      }
      continue;
    }
    const result = await infer({ id: item.content_id, text: content.text });
    if (!result || result.error || !Array.isArray(result.vector)) {
      skipped += 1;
      if (!parked) watermark = item.derivative_id;
      log.info(`content ${item.content_id}: no text vector`);
      continue;
    }
    await ctx.vault.invoke({
      command: "enrich.upsert_embedding",
      input: {
        entity_type: "core.content_item",
        entity_id: item.content_id,
        model,
        vector: result.vector,
        capability: "embed-text",
        source_version: item.derivative_id,
      },
    });
    derived += 1;
    if (!parked) watermark = item.derivative_id;
  }
  if (watermark) await ctx.state.set("cursor", watermark);
  return {
    summary: `embedded ${derived} texts; skipped ${skipped}; not ready ${notReady}; bounded batch ${read.rows?.length ?? 0}/${BATCH}`,
    output: {
      derived,
      skipped,
      notReady,
      model,
      rearm: (read.rows?.length ?? 0) === BATCH,
    },
  };
}
