/**
 * Photo captions (issue #299 phase 1) — the vision enricher.
 *
 * Walks the library forward from a cursor (asset ids are UUIDv7, so id
 * order IS time order — no wall clock needed), and for each new photo:
 *   1. finds which derivative exists (preview, else thumb) — DERIVATIVES
 *      EGRESS, NEVER ORIGINALS; a photo with neither is skipped honestly
 *      and retried when a later run finds one;
 *   2. asks one bounded vision turn (`ctx.agent` with a content ref — the
 *      host resolves the bytes under this agent's grant and receipts the
 *      fetch as its own consent event);
 *   3. stages the caption (knowledge.annotation) and tags (core.tag,
 *      confidence-scored) via `sync.stage_rows` on the `enrichment.vision`
 *      connection. Staged by default; the owner's auto-publish trust on
 *      that connection is what lets them land without a review click.
 *
 * Deterministic by construction: the cursor lives in ctx.state, external
 * ids derive from asset ids, and a re-run of the same batch re-stages the
 * same rows — the spine's content-hash dedup skips them.
 */

const BATCH = 8;
const PURPOSE = 'dpv:ServiceProvision';

const CAPTION_SCHEMA = {
  type: 'object',
  required: ['caption', 'tags'],
  additionalProperties: false,
  properties: {
    caption: {
      type: 'string',
      description: 'One factual sentence describing what is visibly in the photo.',
    },
    tags: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        required: ['label', 'confidence'],
        additionalProperties: false,
        properties: {
          label: { type: 'string', description: 'A short scene/object label, e.g. "beach".' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
};

export default async ({ ctx, log }) => {
  const cursor = (await ctx.state.get('cursor')) ?? '';
  // The on-demand queue drains FIRST (issue #299 phase 5): an owner search
  // that found nothing, or an opened unenriched photo, names specific
  // assets — those jump the backlog regardless of the cursor.
  const requested = await ctx.vault.read({
    entity: 'enrich.request',
    where: [
      { column: 'entity_type', op: 'eq', value: 'media.media_asset' },
      { column: 'entity_id', op: 'not-null' },
      { column: 'drained_at', op: 'is-null' },
    ],
    orderBy: { column: 'request_id', dir: 'asc' },
    limit: 5,
    purpose: PURPOSE,
  });
  const requests = requested.rows ?? [];
  const requestedAssets = [];
  for (const request of requests) {
    const hit = await ctx.vault.read({
      entity: 'media.media_asset',
      where: [
        { column: 'asset_id', op: 'eq', value: request.entity_id },
        { column: 'deleted_at', op: 'is-null' },
      ],
      limit: 1,
      purpose: PURPOSE,
    });
    if (hit.rows?.[0]) requestedAssets.push(hit.rows[0]);
  }

  const read = await ctx.vault.read({
    entity: 'media.media_asset',
    where: [
      { column: 'asset_id', op: 'gt', value: cursor },
      { column: 'deleted_at', op: 'is-null' },
    ],
    orderBy: { column: 'asset_id', dir: 'asc' },
    limit: BATCH,
    purpose: PURPOSE,
  });
  const fresh = read.rows ?? [];
  const seen = new Set(requestedAssets.map((a) => a.asset_id));
  const assets = [...requestedAssets, ...fresh.filter((a) => !seen.has(a.asset_id))];
  if (assets.length === 0) return { summary: 'no new photos — library is fully captioned' };

  const rows = [];
  let captioned = 0;
  let skipped = 0;
  let lastSeen = cursor;
  for (const asset of assets) {
    if (fresh.includes(asset)) lastSeen = asset.asset_id > lastSeen ? asset.asset_id : lastSeen;
    if (asset.kind !== 'photo' && asset.kind !== 'scan') continue;
    // Which derivative exists? Only thumb/preview are agent-readable.
    const derivatives = await ctx.vault.read({
      entity: 'core.content_derivative',
      where: [{ column: 'content_id', op: 'eq', value: asset.content_id }],
      limit: 5,
      purpose: PURPOSE,
    });
    const variants = (derivatives.rows ?? []).map((d) => d.variant);
    const variant = variants.includes('preview')
      ? 'preview'
      : variants.includes('thumb')
        ? 'thumb'
        : null;
    if (!variant) {
      // No derivative yet (e.g. upload without a client thumb) — honest
      // skip; the cursor moves on and a manual re-run can revisit.
      skipped += 1;
      log.info(`asset ${asset.asset_id}: no preview/thumb derivative yet — skipped`);
      continue;
    }
    const out = await ctx.agent({
      prompt:
        'Look at the attached photo. Return a one-sentence factual caption of what is visibly ' +
        'in it, plus up to 6 short scene/object tags with confidence 0..1. Describe only what ' +
        'you can see — no guesses about who people are or where this is.',
      json: CAPTION_SCHEMA,
      content: [{ contentId: asset.content_id, variant }],
    });
    if (!out || typeof out.caption !== 'string' || out.caption.length === 0) {
      skipped += 1;
      continue;
    }
    rows.push({
      entity_type: 'knowledge.annotation',
      external_id: `${asset.asset_id}:caption`,
      payload: {
        target_type: 'media.media_asset',
        target_id: asset.asset_id,
        body: out.caption,
      },
    });
    for (const tag of Array.isArray(out.tags) ? out.tags : []) {
      if (typeof tag.label !== 'string' || tag.label.length === 0) continue;
      rows.push({
        entity_type: 'core.tag',
        external_id: `${asset.asset_id}:tag:${tag.label.toLowerCase()}`,
        payload: {
          target_type: 'media.media_asset',
          target_id: asset.asset_id,
          label: tag.label,
          confidence: Math.max(0, Math.min(1, Number(tag.confidence) || 0)),
        },
      });
    }
    captioned += 1;
  }

  let staged = null;
  if (rows.length > 0) {
    staged = await ctx.vault.invoke({
      command: 'sync.stage_rows',
      input: { kind: 'enrichment.vision', label: 'photos', rows },
      purpose: PURPOSE,
    });
  }
  if (requests.length > 0) {
    await ctx.vault.invoke({
      command: 'enrich.mark_requests_drained',
      input: { request_ids: requests.map((r) => r.request_id) },
      purpose: PURPOSE,
    });
  }
  await ctx.state.set('cursor', lastSeen);
  const published = staged && staged.output && staged.output.published;
  return {
    summary: `captioned ${captioned} photo(s), skipped ${skipped}${published ? ' (auto-published)' : rows.length > 0 ? ' (staged for review)' : ''}`,
    output: { captioned, skipped, staged: rows.length },
  };
};
