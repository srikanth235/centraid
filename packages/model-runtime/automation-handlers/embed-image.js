/* oxlint-disable no-await-in-loop -- bounded vault walks preserve cursor and typed-write order */
import {
  EMBED_MODEL_ID,
  embedImage,
  embedWeightsPresent,
} from "../src/capabilities/embed.js";

const BATCH = 16;
let infer = embedImage;
let weightsPresent = embedWeightsPresent;

export function setEmbedImageRuntimeForTests(runtime) {
  infer = runtime?.infer ?? embedImage;
  weightsPresent = runtime?.weightsPresent ?? embedWeightsPresent;
}

function modelAvailable() {
  return weightsPresent() ? EMBED_MODEL_ID : null;
}

async function seedCursor(ctx, model) {
  const latest = await ctx.vault.read({
    entity: "media.asset",
    where: [
      { column: "kind", op: "in", value: ["photo", "scan"] },
      { column: "deleted_at", op: "is-null" },
    ],
    orderBy: { column: "asset_id", dir: "desc" },
    limit: 1,
    purpose: PURPOSE,
  });
  const asset = latest.rows?.[0];
  if (!asset) return "";
  const stamps = await ctx.vault.read({
    entity: "enrich.derivation",
    where: [
      { column: "target_id", op: "eq", value: asset.asset_id },
      { column: "variant", op: "eq", value: "embedding" },
    ],
    limit: 1,
    purpose: PURPOSE,
  });
  return stamps.rows?.[0]?.model === model ? asset.asset_id : "";
}

export default async function handler({ ctx, log }) {
  const model = modelAvailable();
  if (!model)
    return { summary: "image embedding skipped — model assets unavailable" };
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
      { column: "deleted_at", op: "is-null" },
    ],
    orderBy: { column: "asset_id", dir: "asc" },
    limit: BATCH,
    purpose: PURPOSE,
  });
  let derived = 0;
  let skipped = 0;
  for (const asset of read.rows ?? []) {
    if (asset.kind !== "photo" && asset.kind !== "scan") {
      skipped += 1;
      continue;
    }
    const stamps = await ctx.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: asset.asset_id },
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
      contentId: asset.content_id,
      variant: "preview",
      maxBytes: 4 * 1024 * 1024,
      purpose: PURPOSE,
    });
    if (content?.status !== "ok" || content.kind !== "bytes")
      throw new Error(`asset ${asset.asset_id}: preview is unavailable`);
    const result = await infer({
      id: asset.asset_id,
      mediaType: content.mediaType,
      bytes: content.base64,
    });
    if (!result || result.error || !Array.isArray(result.vector)) {
      skipped += 1;
      log.info(`asset ${asset.asset_id}: no image vector`);
      continue;
    }
    await ctx.vault.invoke({
      command: "enrich.upsert_embedding",
      input: {
        entity_type: "media.asset",
        entity_id: asset.asset_id,
        model,
        vector: result.vector,
        capability: "embed-image",
      },
      purpose: PURPOSE,
    });
    derived += 1;
  }
  const last = read.rows?.at(-1)?.asset_id;
  if (last) await ctx.state.set("cursor", last);
  return {
    summary: `embedded ${derived} images; skipped ${skipped}; bounded batch ${read.rows?.length ?? 0}/${BATCH}`,
    output: {
      derived,
      skipped,
      model,
      rearm: (read.rows?.length ?? 0) === BATCH,
    },
  };
}
