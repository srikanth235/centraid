/* oxlint-disable no-await-in-loop -- consent requests and typed writes must settle in steward order */
import {
  FACES_MODEL_ID,
  faces,
  facesWeightsPresent,
} from "../src/capabilities/faces.js";
import { previewUnsupported } from "./preview-status.js";
import {
  NOT_READY_MAX_TICKS,
  failureMessage,
  recordTargetFailure,
} from "./target-failures.js";

const BATCH = 16;
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
    entity: "media.asset",
    where: [
      { column: "asset_id", op: "eq", value: assetId },
      { column: "deleted_at", op: "is-null" },
    ],
    limit: 1,
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
  });
  if (stamps.rows?.[0]?.model === model)
    return { settled: true, derived: 0, skipped: 1, notReady: 0 };
  const content = await ctx.vault.content({
    contentId: asset.content_id,
    variant: "preview",
    maxBytes: 4 * 1024 * 1024,
  });
  // A display rung that has not landed yet is NOT a failure. Ingest
  // contributes the rungs and the sweep backstops them, so the honest answer
  // is "come back later": no `enrich_derivation` stamp is written, the asset
  // stays eligible, and the rest of the batch proceeds. Throwing here failed
  // the whole turn on the FIRST unready asset and, because the walk is
  // ordered, stalled every later one on every subsequent tick (#1011).
  //
  // PENDING and UNSUPPORTED part company here. An original the codec declined
  // outright carries the vault's durable marker, and parking behind it would
  // stall the walk FOREVER rather than for a tick — so it is skipped and the
  // cursor moves past it. No stamp is written: this recipe never looked at the
  // photograph, and a `{count: 0}` faces stamp would claim it did.
  if (content?.status !== "ok" || content.kind !== "bytes") {
    if (await previewUnsupported(ctx, asset.content_id))
      return { settled: true, derived: 0, skipped: 1, notReady: 0 };
    // A PARK IS NOW BOUNDED (#1014, B3). "Come back later" was unbounded, so
    // an asset that is neither ready nor durably declined held every later
    // photograph indefinitely. Each unready tick counts, and after
    // `NOT_READY_MAX_TICKS` the asset is declined `no-preview` durably and the
    // walk moves past it — the record is what health shows.
    const verdict = await recordTargetFailure(ctx, {
      capability: "faces",
      targetType: "media.asset",
      targetId: asset.asset_id,
      reason: "no-preview",
      error: "no preview landed for this asset",
      maxFailures: NOT_READY_MAX_TICKS,
    });
    if (verdict.declined)
      return { settled: true, derived: 0, skipped: 1, notReady: 0 };
    return { settled: false, derived: 0, skipped: 0, notReady: 1 };
  }
  // ONE POISONED PHOTOGRAPH DOES NOT STOP THE LIBRARY (#1014, B2). Throwing
  // here failed the whole turn, and because the walk is `asset_id`-ordered
  // every tick after it died on the same row while health read `ok`.
  let result;
  try {
    result = await infer({
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
    });
  } catch (error) {
    const verdict = await recordTargetFailure(ctx, {
      capability: "faces",
      targetType: "media.asset",
      targetId: asset.asset_id,
      error: failureMessage(error),
      reason: "failed",
    });
    // Under the cap this parks exactly as an unready preview does — one tick
    // lost, the target retried. At the cap the walk advances past it.
    if (verdict.declined)
      return { settled: true, derived: 0, skipped: 1, notReady: 0, failed: 1 };
    return { settled: false, derived: 0, skipped: 0, notReady: 1, failed: 1 };
  }
  return { settled: true, derived: 1, skipped: 0, notReady: 0 };
}

async function seedConsentCursor(ctx, model) {
  const latest = await ctx.vault.read({
    entity: "enrich.derivation",
    where: [{ column: "variant", op: "eq", value: "faces" }],
    orderBy: { column: "target_id", dir: "desc" },
    limit: 1,
  });
  return latest.rows?.[0]?.model === model ? latest.rows[0].target_id : "";
}

/**
 * The ambient pass's cursor seed, the same shape `embed-image` uses: a library
 * whose NEWEST photograph already carries a stamp at this model was derived
 * under an earlier run of this recipe, so the walk starts past it instead of
 * re-reading the whole library. Anything else seeds at the beginning.
 */
async function seedAmbientCursor(ctx, model) {
  const latest = await ctx.vault.read({
    entity: "media.asset",
    where: [
      { column: "kind", op: "in", value: ["photo", "scan"] },
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
      { column: "target_id", op: "eq", value: asset.asset_id },
      { column: "variant", op: "eq", value: "faces" },
    ],
    limit: 1,
  });
  return stamps.rows?.[0]?.model === model ? asset.asset_id : "";
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
    await ctx.state.set(
      "cursor",
      priorModel === undefined ? await seedAmbientCursor(ctx, model) : ""
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
  });
  let derived = 0;
  let skipped = 0;
  let notReady = 0;
  let remaining = BATCH;
  let rearm = (requests.rows?.length ?? 0) === BATCH;
  const drained = [];
  const processed = new Set();
  // Assets this turn found without a preview. A cursor pass must NOT advance
  // past one: the prior-stamp sweep only revisits assets that already carry a
  // faces stamp, and an unready asset writes none — advancing would drop it
  // from every future walk. So each pass parks its watermark on the last
  // asset before the first unready one and re-reads from there next tick.
  const unready = new Set();

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
      if (result.notReady) unready.add(asset.asset_id);
      derived += result.derived;
      skipped += result.skipped;
      notReady += result.notReady;
      remaining -= 1;
      // An unready target leaves its request undrained, so the queue itself
      // carries the retry.
      if (result.settled) drained.push(request.request_id);
      continue;
    }

    const key = `requestCursor:${request.request_id}`;
    const cursor = (await ctx.state.get(key)) ?? "";
    const capacity = remaining;
    const assets = await ctx.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "gt", value: cursor },
        { column: "kind", op: "in", value: ["photo", "scan"] },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "asc" },
      limit: capacity,
    });
    let watermark = "";
    let parked = false;
    for (const asset of assets.rows ?? []) {
      const result = await deriveAsset(ctx, asset, model);
      processed.add(asset.asset_id);
      derived += result.derived;
      skipped += result.skipped;
      notReady += result.notReady;
      remaining -= 1;
      if (result.notReady) {
        unready.add(asset.asset_id);
        parked = true;
      } else if (!parked) watermark = asset.asset_id;
    }
    if (watermark) await ctx.state.set(key, watermark);
    // A parked pass is not drained: this request still owes those assets.
    if (!parked && (assets.rows?.length ?? 0) < capacity) {
      drained.push(request.request_id);
      // THE KEY GOES WITH THE REQUEST (#1014, B19). A `requestCursor:<id>`
      // that outlives its request is state nothing will ever read again, one
      // row per explicit ask, forever.
      await ctx.state.delete(key);
    } else rearm = true;
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
    });
    let watermark = "";
    let parked = false;
    for (const stamp of stamps.rows ?? []) {
      if (processed.has(stamp.target_id)) {
        if (unready.has(stamp.target_id)) parked = true;
        else if (!parked) watermark = stamp.target_id;
        continue;
      }
      const asset = await assetById(ctx, stamp.target_id);
      if (!asset) {
        skipped += 1;
        if (!parked) watermark = stamp.target_id;
        continue;
      }
      const result = await deriveAsset(ctx, asset, model);
      processed.add(asset.asset_id);
      derived += result.derived;
      skipped += result.skipped;
      notReady += result.notReady;
      // One batch budget across all three passes: whatever the priority lanes
      // spend is not available to the ambient walk below.
      remaining -= 1;
      if (result.notReady) {
        unready.add(asset.asset_id);
        parked = true;
      } else if (!parked) watermark = stamp.target_id;
    }
    if (watermark) await ctx.state.set("consentCursor", watermark);
    if ((stamps.rows?.length ?? 0) === capacity) rearm = true;
  }

  // The ambient ingest pass, LAST: the priority lanes above (an owner's
  // explicit ask, a search miss, an on-view request, and content already
  // carrying a faces stamp) drain first and spend from the same batch budget,
  // so a busy queue simply leaves the library walk nothing to do this fire.
  if (remaining > 0) {
    const cursor = (await ctx.state.get("cursor")) ?? "";
    const capacity = remaining;
    const read = await ctx.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "gt", value: cursor },
        { column: "kind", op: "in", value: ["photo", "scan"] },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "asc" },
      limit: capacity,
    });
    let watermark = "";
    let parked = false;
    for (const asset of read.rows ?? []) {
      if (processed.has(asset.asset_id)) {
        if (unready.has(asset.asset_id)) parked = true;
        else if (!parked) watermark = asset.asset_id;
        continue;
      }
      const result = await deriveAsset(ctx, asset, model);
      processed.add(asset.asset_id);
      derived += result.derived;
      skipped += result.skipped;
      notReady += result.notReady;
      remaining -= 1;
      if (result.notReady) {
        unready.add(asset.asset_id);
        parked = true;
      } else if (!parked) watermark = asset.asset_id;
    }
    if (watermark) await ctx.state.set("cursor", watermark);
    if ((read.rows?.length ?? 0) === capacity) rearm = true;
  }

  if (drained.length)
    await ctx.vault.invoke({
      command: "enrich.mark_requests_drained",
      input: { request_ids: drained },
    });
  if (derived > 0)
    await ctx.vault.invoke({
      command: "enrich.rebuild_face_clusters",
      input: {},
    });
  return {
    summary: `faces derived ${derived}; skipped ${skipped}; not ready ${notReady}; request queue batch ${requests.rows?.length ?? 0}/${BATCH}`,
    output: {
      derived,
      skipped,
      notReady,
      drained: drained.length,
      model,
      rearm,
    },
  };
}
