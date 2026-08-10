/* oxlint-disable no-await-in-loop -- consent requests and typed writes must settle in steward order */
import {
  FACES_MODEL_ID,
  faces,
  facesWeightsPresent,
} from "../src/capabilities/faces.js";

const BATCH = 16;
const PURPOSE = "dpv:ServiceProvision";
let infer = faces;
let weightsPresent = facesWeightsPresent;

export function setFacesRuntimeForTests(runtime) {
  infer = runtime?.infer ?? faces;
  weightsPresent = runtime?.weightsPresent ?? facesWeightsPresent;
}

function modelAvailable() {
  return weightsPresent() ? FACES_MODEL_ID : null;
}

async function assetById(ctx, assetId) {
  const rows = await ctx.vault.read({
    entity: "media.media_asset",
    where: [
      { column: "asset_id", op: "eq", value: assetId },
      { column: "deleted_at", op: "is-null" },
    ],
    limit: 1,
    purpose: PURPOSE,
  });
  return rows.rows?.[0];
}

async function deriveAsset(ctx, asset, model) {
  const stamps = await ctx.vault.read({
    entity: "enrich.derivation",
    where: [
      { column: "target_id", op: "eq", value: asset.asset_id },
      { column: "variant", op: "eq", value: "faces" },
    ],
    limit: 1,
    purpose: PURPOSE,
  });
  if (stamps.rows?.[0]?.model === model)
    return { settled: true, derived: 0, skipped: 1 };
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
    bytes: content.base64,
    mediaType: content.mediaType,
    originalWidth: asset.width,
    originalHeight: asset.height,
  });
  if (!result || result.error || !Array.isArray(result.faces))
    throw new Error(
      result?.error ??
        `asset ${asset.asset_id}: face detector returned no result`
    );
  await ctx.vault.invoke({
    command: "enrich.upsert_faces",
    input: { asset_id: asset.asset_id, model, faces: result.faces },
    purpose: PURPOSE,
  });
  return { settled: true, derived: 1, skipped: 0 };
}

async function seedConsentCursor(ctx, model) {
  const latest = await ctx.vault.read({
    entity: "enrich.derivation",
    where: [{ column: "variant", op: "eq", value: "faces" }],
    orderBy: { column: "target_id", dir: "desc" },
    limit: 1,
    purpose: PURPOSE,
  });
  return latest.rows?.[0]?.model === model ? latest.rows[0].target_id : "";
}

export default async function handler({ ctx }) {
  const model = modelAvailable();
  if (!model)
    return { summary: "faces skipped — automation model assets unavailable" };
  const priorModel = await ctx.state.get("model");
  if (priorModel !== model) {
    await ctx.state.set(
      "consentCursor",
      priorModel === undefined ? await seedConsentCursor(ctx, model) : ""
    );
    await ctx.state.set("model", model);
  }

  const requests = await ctx.vault.read({
    entity: "enrich.request",
    where: [
      { column: "capability", op: "eq", value: "faces" },
      { column: "drained_at", op: "is-null" },
    ],
    orderBy: { column: "request_id", dir: "asc" },
    limit: BATCH,
    purpose: PURPOSE,
  });
  let derived = 0;
  let skipped = 0;
  let remaining = BATCH;
  let rearm = (requests.rows?.length ?? 0) === BATCH;
  const drained = [];
  const processed = new Set();

  for (const request of requests.rows ?? []) {
    if (remaining === 0) {
      rearm = true;
      break;
    }
    if (request.target_id) {
      const asset = await assetById(ctx, request.target_id);
      if (!asset) {
        skipped += 1;
        drained.push(request.request_id);
        remaining -= 1;
        continue;
      }
      const result = await deriveAsset(ctx, asset, model);
      processed.add(asset.asset_id);
      derived += result.derived;
      skipped += result.skipped;
      remaining -= 1;
      if (result.settled) drained.push(request.request_id);
      continue;
    }

    const key = `requestCursor:${request.request_id}`;
    const cursor = (await ctx.state.get(key)) ?? "";
    const capacity = remaining;
    const assets = await ctx.vault.read({
      entity: "media.media_asset",
      where: [
        { column: "asset_id", op: "gt", value: cursor },
        { column: "kind", op: "in", value: ["photo", "scan"] },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "asc" },
      limit: capacity,
      purpose: PURPOSE,
    });
    for (const asset of assets.rows ?? []) {
      const result = await deriveAsset(ctx, asset, model);
      processed.add(asset.asset_id);
      derived += result.derived;
      skipped += result.skipped;
      remaining -= 1;
    }
    const last = assets.rows?.at(-1)?.asset_id;
    if (last) await ctx.state.set(key, last);
    if ((assets.rows?.length ?? 0) < capacity) drained.push(request.request_id);
    else rearm = true;
  }

  if (remaining > 0) {
    const cursor = (await ctx.state.get("consentCursor")) ?? "";
    const capacity = remaining;
    const stamps = await ctx.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "gt", value: cursor },
        { column: "variant", op: "eq", value: "faces" },
      ],
      orderBy: { column: "target_id", dir: "asc" },
      limit: capacity,
      purpose: PURPOSE,
    });
    for (const stamp of stamps.rows ?? []) {
      if (processed.has(stamp.target_id)) continue;
      const asset = await assetById(ctx, stamp.target_id);
      if (!asset) {
        skipped += 1;
        continue;
      }
      const result = await deriveAsset(ctx, asset, model);
      derived += result.derived;
      skipped += result.skipped;
    }
    const last = stamps.rows?.at(-1)?.target_id;
    if (last) await ctx.state.set("consentCursor", last);
    if ((stamps.rows?.length ?? 0) === capacity) rearm = true;
  }

  if (drained.length)
    await ctx.vault.invoke({
      command: "enrich.mark_requests_drained",
      input: { request_ids: drained },
      purpose: PURPOSE,
    });
  if (derived > 0)
    await ctx.vault.invoke({
      command: "enrich.rebuild_face_clusters",
      input: {},
      purpose: PURPOSE,
    });
  return {
    summary: `faces derived ${derived}; skipped ${skipped}; consent queue batch ${requests.rows?.length ?? 0}/${BATCH}`,
    output: { derived, skipped, drained: drained.length, model, rearm },
  };
}
