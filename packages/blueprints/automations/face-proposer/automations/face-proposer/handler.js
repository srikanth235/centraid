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
 */

const BATCH = 8;
const PURPOSE = 'dpv:ServiceProvision';

const FACES_SCHEMA = {
  type: 'object',
  required: ['faces'],
  additionalProperties: false,
  properties: {
    faces: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        required: ['x', 'y', 'w', 'h', 'confidence'],
        additionalProperties: false,
        properties: {
          x: { type: 'number', minimum: 0, maximum: 1 },
          y: { type: 'number', minimum: 0, maximum: 1 },
          w: { type: 'number', minimum: 0, maximum: 1 },
          h: { type: 'number', minimum: 0, maximum: 1 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
};

export default async ({ ctx, log }) => {
  const cursor = (await ctx.state.get('cursor')) ?? '';
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
  const assets = read.rows ?? [];
  if (assets.length === 0) return { summary: 'no new photos to scan for faces' };

  const rows = [];
  let proposed = 0;
  let lastSeen = cursor;
  for (const asset of assets) {
    lastSeen = asset.asset_id;
    if (asset.kind !== 'photo') continue;
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
    if (!variant) continue;
    const out = await ctx.agent({
      prompt:
        'Find the human faces in the attached photo. Return each as a normalized box ' +
        '(x, y = top-left, w, h — all 0..1 fractions of the image) with a confidence score. ' +
        'Mark WHERE faces are only — never describe or identify anyone.',
      json: FACES_SCHEMA,
      content: [{ contentId: asset.content_id, variant }],
    });
    const faces = Array.isArray(out?.faces) ? out.faces : [];
    faces.forEach((face, n) => {
      rows.push({
        entity_type: 'media.face_region',
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
      command: 'sync.stage_rows',
      input: { kind: 'enrichment.faces', label: 'photos', rows },
      purpose: PURPOSE,
    });
    log.info(`${rows.length} face region(s) proposed across ${proposed} photo(s)`);
  }
  await ctx.state.set('cursor', lastSeen);
  return {
    summary: `proposed ${rows.length} face region(s) in ${proposed} photo(s)`,
    output: { regions: rows.length, photos: proposed },
  };
};
