/**
 * Face proposals (issue #299 phase 3) — the propose half of the loop the
 * `media_face_region` schema always carried (`confirmed_by_party_id` is
 * the owner's half, exercised in Photos).
 *
 * Deliberately identity-blind: the model marks WHERE faces are, never WHO
 * they are — naming a person is the owner's assertion, made in the app.
 * Proposals land through the face-region publisher, which refuses to touch
 * confirmed rows; external ids are `<asset_id>:face:<n>` so a re-run diffs
 * instead of duplicating.
 *
 * The on-demand queue drains FIRST (issue #352 phase 3/4, mirroring
 * photo-captioner): an owner clicking "detect faces" on a specific photo in
 * Photos calls `enrich.request_enrichment` with entity_type
 * `media.media_asset` and that asset's id — those jump the cursor-ordered
 * backlog below regardless of where the sweep currently is.
 */

const BATCH = 8;
/** This enricher's consent scope — must match automation.json `enrich.capability`. */
const CAPABILITY = "faces";
const PURPOSE = "dpv:ServiceProvision";

const FACES_SCHEMA = {
  type: "object",
  required: ["faces"],
  additionalProperties: false,
  properties: {
    faces: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        required: ["x", "y", "w", "h", "confidence"],
        additionalProperties: false,
        properties: {
          x: { type: "number", minimum: 0, maximum: 1 },
          y: { type: "number", minimum: 0, maximum: 1 },
          w: { type: "number", minimum: 0, maximum: 1 },
          h: { type: "number", minimum: 0, maximum: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
  },
};

export default async function handler({ ctx, log }) {
  const cursor = (await ctx.state.get("cursor")) ?? "";
  // The on-demand queue drains FIRST (issue #352 phase 3/4) — see header.
  //
  // Two reads, because the vault's `where` grammar is AND-only and this
  // enricher is entitled to exactly two kinds of row:
  //   * `capability = 'faces'` — an OWNER's consented "detect faces now".
  //     Rows tagged for another enricher are not ours to touch: that tag is
  //     the whole point of the consent scope (schema/enrich.ts).
  //   * `capability IS NULL` — the untagged system signals (search-miss /
  //     on-view). Those are not consent and stay broadcast; the DDL forbids
  //     an untagged `manual` row, so nothing here can be an owner ask.
  //
  // The filter columns are the table's real ones (`target_type`/`target_id`);
  // the pre-#352-era `entity_type`/`entity_id` names are not columns of
  // `enrich_request` and made every one of these reads throw
  // `unknown column` — i.e. the on-demand queue never actually drained.
  const queueFilter = (capabilityClause) => ({
    entity: "enrich.request",
    where: [
      { column: "target_type", op: "eq", value: "media.media_asset" },
      { column: "target_id", op: "not-null" },
      { column: "required_capability", op: "is-null" },
      { column: "drained_at", op: "is-null" },
      capabilityClause,
    ],
    orderBy: { column: "request_id", dir: "asc" },
    limit: 5,
    purpose: PURPOSE,
  });
  const mine = await ctx.vault.read(
    queueFilter({ column: "capability", op: "eq", value: CAPABILITY })
  );
  const untagged = await ctx.vault.read(
    queueFilter({ column: "capability", op: "is-null" })
  );
  // Deduped by request_id: the two reads are disjoint by construction, but a
  // row must never be drained (or charged for) twice if that ever stops
  // holding.
  const byId = new Map();
  for (const request of [...(mine.rows ?? []), ...(untagged.rows ?? [])])
    if (!byId.has(request.request_id)) byId.set(request.request_id, request);
  const requests = [...byId.values()].slice(0, 5);
  const requestedAssets = [];
  for (const request of requests) {
    const hit = await ctx.vault.read({
      entity: "media.media_asset",
      where: [
        { column: "asset_id", op: "eq", value: request.target_id },
        { column: "deleted_at", op: "is-null" },
      ],
      limit: 1,
      purpose: PURPOSE,
    });
    if (hit.rows?.[0]) requestedAssets.push(hit.rows[0]);
  }

  const read = await ctx.vault.read({
    entity: "media.media_asset",
    where: [
      { column: "asset_id", op: "gt", value: cursor },
      { column: "deleted_at", op: "is-null" },
    ],
    orderBy: { column: "asset_id", dir: "asc" },
    limit: BATCH,
    purpose: PURPOSE,
  });
  const fresh = read.rows ?? [];
  const seen = new Set(requestedAssets.map((a) => a.asset_id));
  const assets = [
    ...requestedAssets,
    ...fresh.filter((a) => !seen.has(a.asset_id)),
  ];
  if (assets.length === 0)
    return { summary: "no new photos to scan for faces" };

  const rows = [];
  let proposed = 0;
  let lastSeen = cursor;
  for (const asset of assets) {
    if (fresh.includes(asset))
      lastSeen = asset.asset_id > lastSeen ? asset.asset_id : lastSeen;
    if (asset.kind !== "photo") continue;
    const derivatives = await ctx.vault.read({
      entity: "core.content_derivative",
      where: [{ column: "content_id", op: "eq", value: asset.content_id }],
      limit: 5,
      purpose: PURPOSE,
    });
    const variants = (derivatives.rows ?? []).map((d) => d.variant);
    const variant = variants.includes("preview")
      ? "preview"
      : variants.includes("thumb")
        ? "thumb"
        : null;
    if (!variant) continue;
    const out = await ctx.agent({
      prompt:
        "Find the human faces in the attached photo. Return each as a normalized box " +
        "(x, y = top-left, w, h — all 0..1 fractions of the image) with a confidence score. " +
        "Mark WHERE faces are only — never describe or identify anyone.",
      json: FACES_SCHEMA,
      content: [{ contentId: asset.content_id, variant }],
    });
    const faces = Array.isArray(out?.faces) ? out.faces : [];
    faces.forEach((face, n) => {
      rows.push({
        entity_type: "media.face_region",
        external_id: `${asset.asset_id}:face:${n}`,
        payload: {
          asset_id: asset.asset_id,
          bbox: { x: face.x, y: face.y, w: face.w, h: face.h },
          confidence: Math.max(0, Math.min(1, Number(face.confidence) || 0)),
        },
      });
    });
    if (faces.length > 0) proposed += 1;
  }

  if (rows.length > 0) {
    await ctx.vault.invoke({
      command: "sync.stage_rows",
      input: { kind: "enrichment.faces", label: "photos", rows },
      purpose: PURPOSE,
    });
    log.info(
      `${rows.length} face region(s) proposed across ${proposed} photo(s)`
    );
  }
  if (requests.length > 0) {
    await ctx.vault.invoke({
      command: "enrich.mark_requests_drained",
      input: { request_ids: requests.map((r) => r.request_id) },
      purpose: PURPOSE,
    });
  }
  await ctx.state.set("cursor", lastSeen);
  return {
    summary: `proposed ${rows.length} face region(s) in ${proposed} photo(s)`,
    output: { regions: rows.length, photos: proposed },
  };
}
