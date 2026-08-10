/* oxlint-disable no-await-in-loop -- bounded vault walks preserve cursor and typed-write order */
import {
  EMBED_MODEL_ID,
  embedText,
  embedWeightsPresent,
} from "../src/capabilities/embed.js";

const BATCH = 16;
const PURPOSE = "dpv:ServiceProvision";
let infer = embedText;
let weightsPresent = embedWeightsPresent;

export function setEmbedTextRuntimeForTests(runtime) {
  infer = runtime?.infer ?? embedText;
  weightsPresent = runtime?.weightsPresent ?? embedWeightsPresent;
}

function modelAvailable() {
  return weightsPresent() ? EMBED_MODEL_ID : null;
}

async function seedCursor(ctx, model) {
  const latest = await ctx.vault.read({
    entity: "core.content_derivative",
    where: [{ column: "variant", op: "in", value: ["text", "transcript"] }],
    orderBy: { column: "derivative_id", dir: "desc" },
    limit: 1,
    purpose: PURPOSE,
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
    purpose: PURPOSE,
  });
  return stamps.rows?.[0]?.model === model ? item.derivative_id : "";
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
    purpose: PURPOSE,
  });
  let derived = 0;
  let skipped = 0;
  for (const item of read.rows ?? []) {
    const stamps = await ctx.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: item.content_id },
        { column: "variant", op: "eq", value: "embedding" },
      ],
      limit: 1,
      purpose: PURPOSE,
    });
    if (stamps.rows?.[0]?.model === model) {
      skipped += 1;
      continue;
    }
    const content = await ctx.vault.content({
      contentId: item.content_id,
      variant: item.variant,
      maxBytes: 1024 * 1024,
      purpose: PURPOSE,
    });
    const result =
      content?.status === "ok" && content.kind === "text"
        ? await infer({ id: item.content_id, text: content.text })
        : null;
    if (!result || result.error || !Array.isArray(result.vector)) {
      skipped += 1;
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
      },
      purpose: PURPOSE,
    });
    derived += 1;
  }
  const last = read.rows?.at(-1)?.derivative_id;
  if (last) await ctx.state.set("cursor", last);
  return {
    summary: `embedded ${derived} texts; skipped ${skipped}; bounded batch ${read.rows?.length ?? 0}/${BATCH}`,
    output: {
      derived,
      skipped,
      model,
      rearm: (read.rows?.length ?? 0) === BATCH,
    },
  };
}
