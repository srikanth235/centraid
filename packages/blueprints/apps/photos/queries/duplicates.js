/**
 * Near-duplicate clusters over the live library (issue #352 phase 3 /
 * issue #299's deferred "duplicates shelf").
 *
 * The perceptual-hash infra issue #299 built (`media_asset_phash` sidecar +
 * the `vault_hamming` SQL function, packages/vault/src/enrich/similarity.ts)
 * is NOT reachable from this app-plane query today:
 *   - `media_asset_phash` is not a registered logical entity — the schema
 *     registry (packages/vault/src/schema/tables.ts VAULT_TABLES) lists only
 *     `media.media_asset` and `media.face_region` under the `media` schema,
 *     so `ctx.vault.read({ entity: 'media.asset_phash', … })` denies with
 *     "unknown entity" — there is no logical name that resolves to it.
 *   - Even if there were, `ctx.vault.read`/consent.app_view only support
 *     column-comparison filters (packages/vault/src/gateway/filters.ts —
 *     eq/ne/lt/gt/in/is-null/…) and FK-declared joins
 *     (packages/vault/src/gateway/views.ts) — neither can express a
 *     self-join scored by a custom SQL function like `vault_hamming(a, b)`.
 * Reaching phash-based clustering would need a vault-side change (e.g. a
 * dedicated gateway "similar" op) — outside this app's territory. Filed as
 * a follow-up rather than worked around here.
 *
 * The nearest workable signal from the app plane: exact-sha byte duplicates
 * are structurally impossible in this vault — `media_media_asset.content_id`
 * is UNIQUE and `core_content_item.sha256` is UNIQUE (media.add_asset dedupes
 * identical bytes onto the SAME asset at upload, never creating a second
 * live asset over the same content) — so that tier is included defensively
 * (correct if that invariant is ever relaxed, e.g. by a future import path)
 * but will normally cluster nothing. The tier that actually finds anything
 * today is "same pixel dimensions + same byte size" among distinct assets:
 * a coarse fingerprint (two DIFFERENT photos could coincidentally share both
 * numbers, especially common resolutions/sizes) but a real signal for the
 * common case this shelf targets — the same photo re-exported or re-uploaded
 * from a second source, landing as a second asset over different bytes.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
export default async ({ ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  try {
    const liveAssets = await ctx.vault.read({
      entity: 'media.media_asset',
      where: [{ column: 'deleted_at', op: 'is-null' }],
      orderBy: { column: 'captured_at', dir: 'desc' },
      limit: 4000,
      purpose,
    });
    const rows = liveAssets.rows ?? [];
    if (rows.length < 2) return { clusters: [], limitation: 'phash-unreachable' };

    const contentIds = [...new Set(rows.map((a) => a.content_id))];
    const contents = await ctx.vault.read({
      entity: 'core.content_item',
      where: [{ column: 'content_id', op: 'in', value: contentIds }],
      purpose,
    });
    const contentById = new Map((contents.rows ?? []).map((c) => [c.content_id, c]));

    const BLOB_ROUTE = '/centraid/_vault/blobs';
    const srcOf = (content) => {
      const uri = content?.content_uri;
      if (typeof uri !== 'string') return { src: null, thumb: null };
      if (!uri.startsWith('blob:')) return { src: uri, thumb: null };
      const src = `${BLOB_ROUTE}/${content.content_id}`;
      return { src, thumb: `${src}?variant=thumb` };
    };

    const withContent = rows
      .map((asset) => {
        const content = contentById.get(asset.content_id);
        if (!content || content.deleted_at != null) return null;
        const { src, thumb } = srcOf(content);
        return {
          asset_id: asset.asset_id,
          content_id: asset.content_id,
          sha256: content.sha256 ?? null,
          kind: asset.kind,
          width: asset.width ?? null,
          height: asset.height ?? null,
          byte_size: content.byte_size ?? null,
          media_type: content.media_type ?? null,
          title: content.title ?? null,
          taken_at: asset.captured_at ?? content.created_at ?? null,
          content_uri: src,
          thumb_uri: thumb,
        };
      })
      .filter((a) => a != null);

    // Tier 1: exact-sha groups (see doc comment — expected to stay empty).
    const bySha = new Map();
    for (const a of withContent) {
      if (!a.sha256) continue;
      if (!bySha.has(a.sha256)) bySha.set(a.sha256, []);
      bySha.get(a.sha256).push(a);
    }
    const clustered = new Set();
    const clusters = [];
    for (const [sha, group] of bySha) {
      if (group.length < 2) continue;
      clusters.push({ key: sha, tier: 'exact', assets: group });
      for (const a of group) clustered.add(a.asset_id);
    }

    // Tier 2: same (width, height, byte_size) among assets not already
    // claimed by an exact-sha cluster.
    const byDims = new Map();
    for (const a of withContent) {
      if (clustered.has(a.asset_id)) continue;
      if (a.width == null || a.height == null || a.byte_size == null) continue;
      const key = `${a.width}x${a.height}|${a.byte_size}`;
      if (!byDims.has(key)) byDims.set(key, []);
      byDims.get(key).push(a);
    }
    for (const [key, group] of byDims) {
      if (group.length < 2) continue;
      clusters.push({ key, tier: 'near', assets: group });
    }

    clusters.sort((a, b) => b.assets.length - a.assets.length);
    return { clusters, limitation: 'phash-unreachable' };
  } catch (err) {
    return { clusters: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
