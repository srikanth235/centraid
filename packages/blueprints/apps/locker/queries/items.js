/**
 * The locker as a bounded recent window: non-trashed locker_item rows,
 * newest-updated first (caller-sized, default 300), each decorated with its
 * favorite (the canonical flags-scheme star on target_type 'locker.item',
 * issue #274), its free-form tags, a safe subtitle, and its derived Watchtower
 * status. Secrets are SEALED columns (issue #293): a read returns
 * placeholders, so weak/reused and a card's last-four come from the
 * `locker.watchtower` command — derived INSIDE the vault's sealed boundary,
 * with the unseal receipted. Compromised is the one stored flag. Secrets
 * NEVER ride this payload; only the single-item query reveals them.
 * `truncated` tells the UI older items exist beyond the window. Everything
 * comes from the vault; this app holds no rows of its own.
 *
 * @type {import('@centraid/app-engine').QueryHandler}
 */

const FLAGS_SCHEME_URI = 'https://centraid.dev/schemes/flags';
const LOCKER_TAGS_SCHEME_URI = 'https://centraid.dev/schemes/locker-tags';
const ITEM_TYPE = 'locker.item';

/** A safe, secret-free subtitle for a list row. */
function subtitleOf(it, watch) {
  switch (it.type) {
    case 'login':
      return it.username || '—';
    case 'card':
      return watch?.last4 ? `•••• ${watch.last4}` : 'Card';
    case 'note':
      return 'Secure note';
    case 'identity':
      return it.email || '—';
    case 'wifi':
      return it.network || '—';
    default:
      return 'Password';
  }
}

/**
 * Watchtower derivatives per item id: {weak, reused, last4?}. Computed by
 * the vault (`locker.watchtower`, issue #293) — passwords never leave the
 * sealed boundary. Fail-soft: no grant → an empty map, list still renders.
 */
export async function readWatchtower(ctx, purpose) {
  const map = new Map();
  try {
    const out = await ctx.vault.invoke({ command: 'locker.watchtower', input: {}, purpose });
    if (out.status !== 'executed') return map;
    for (const entry of out.output?.items ?? []) map.set(entry.item_id, entry);
  } catch {
    /* fail soft */
  }
  return map;
}

/** Build the secret-free decorated rows for a set of raw item rows. */
export function decorate(rows, tagsByItem, starredIds, watchByItem) {
  return rows.map((it) => {
    const watch = watchByItem?.get(it.item_id);
    const weak = !!watch?.weak;
    const reused = !!watch?.reused;
    const compromised = it.compromised === 1 || it.compromised === true;
    const severity = compromised ? 'danger' : weak || reused ? 'warn' : '';
    return {
      item_id: it.item_id,
      type: it.type,
      title: it.title,
      subtitle: subtitleOf(it, watch),
      favorite: starredIds.has(it.item_id),
      tags: tagsByItem.get(it.item_id) ?? [],
      weak,
      reused,
      compromised,
      severity,
      updated_at: it.updated_at,
      purge_at: it.purge_at ?? null,
    };
  });
}

/**
 * Read the two SKOS vocabulary tables once. `readTags` and `readStarred` both
 * need `core.concept` + `core.concept_scheme` (issue #310 S3) — read them
 * together and hand the result to both so a single items read doesn't hit each
 * table twice (issue #404).
 */
export async function readConceptTables(ctx, purpose) {
  const [concepts, schemes] = await Promise.all([
    ctx.vault.read({ entity: 'core.concept', purpose }),
    ctx.vault.read({ entity: 'core.concept_scheme', purpose }),
  ]);
  return { concepts: concepts.rows ?? [], schemes: schemes.rows ?? [] };
}

/**
 * Read tags for a set of item ids into item_id → string[]. Tags are SKOS
 * concepts in the locker-tags scheme carried by core_tag rows (issue #310
 * S3) — the same canonical mechanism the star already rides. Pass `tables`
 * (from `readConceptTables`) to share the vocabulary read with `readStarred`.
 */
export async function readTags(ctx, ids, purpose, tables) {
  const map = new Map();
  if (ids.length === 0) return map;
  const vocab = tables ?? (await readConceptTables(ctx, purpose));
  const tags = await ctx.vault.read({
    entity: 'core.tag',
    where: [
      { column: 'target_type', op: 'eq', value: ITEM_TYPE },
      { column: 'target_id', op: 'in', value: ids },
    ],
    purpose,
  });
  const tagScheme = vocab.schemes.find((s) => s.uri === LOCKER_TAGS_SCHEME_URI);
  if (!tagScheme) return map;
  const labelByConcept = new Map(
    vocab.concepts
      .filter((c) => c.scheme_id === tagScheme.scheme_id)
      .map((c) => [c.concept_id, c.pref_label]),
  );
  for (const t of tags.rows ?? []) {
    const label = labelByConcept.get(t.concept_id);
    if (!label) continue; // a flags-scheme star, not a tag
    if (!map.has(t.target_id)) map.set(t.target_id, []);
    map.get(t.target_id).push(label);
  }
  for (const arr of map.values()) arr.sort();
  return map;
}

/**
 * Read the starred flag ids for a set of item ids (flags-scheme star). Pass
 * `tables` (from `readConceptTables`) to share the vocabulary read with
 * `readTags`.
 */
export async function readStarred(ctx, ids, purpose, tables) {
  const starred = new Set();
  if (ids.length === 0) return starred;
  const vocab = tables ?? (await readConceptTables(ctx, purpose));
  const flagsScheme = vocab.schemes.find((s) => s.uri === FLAGS_SCHEME_URI);
  const starredConcept = flagsScheme
    ? vocab.concepts.find((c) => c.scheme_id === flagsScheme.scheme_id && c.notation === 'starred')
    : undefined;
  if (!starredConcept) return starred;
  const tags = await ctx.vault.read({
    entity: 'core.tag',
    where: [
      { column: 'concept_id', op: 'eq', value: starredConcept.concept_id },
      { column: 'target_type', op: 'eq', value: ITEM_TYPE },
      { column: 'target_id', op: 'in', value: ids },
    ],
    purpose,
  });
  for (const t of tags.rows ?? []) starred.add(t.target_id);
  return starred;
}

export default async ({ input, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const window = Math.min(Math.max(Number(input?.limit) || 300, 20), 2000);
  try {
    const res = await ctx.vault.read({
      entity: 'locker.item',
      where: [{ column: 'deleted_at', op: 'is-null' }],
      orderBy: { column: 'updated_at', dir: 'desc' },
      limit: window,
      purpose,
    });
    const rows = res.rows ?? [];
    const ids = rows.map((r) => r.item_id);
    // One vocabulary read shared by readTags + readStarred, and ONE watchtower
    // unseal — the sidebar badge + Watchtower panel are derived from this same
    // decorated set instead of a second full read + second receipted unseal
    // (issue #404).
    const vocab = await readConceptTables(ctx, purpose);
    const [tagsByItem, starredIds, watchByItem] = await Promise.all([
      readTags(ctx, ids, purpose, vocab),
      readStarred(ctx, ids, purpose, vocab),
      readWatchtower(ctx, purpose),
    ]);
    const items = decorate(rows, tagsByItem, starredIds, watchByItem);
    const affected = items.filter((it) => it.compromised || it.weak || it.reused);
    const watchtower = {
      compromised: items.filter((it) => it.compromised).length,
      weak: items.filter((it) => it.weak).length,
      reused: items.filter((it) => it.reused).length,
      items: affected,
    };
    return { items, watchtower, truncated: rows.length >= window, window };
  } catch (err) {
    return { items: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
