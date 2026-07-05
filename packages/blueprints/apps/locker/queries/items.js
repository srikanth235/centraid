/**
 * The locker as a bounded recent window: non-trashed locker_item rows,
 * newest-updated first (caller-sized, default 300), each decorated with its
 * favorite (the canonical flags-scheme star on target_type 'locker.item',
 * issue #274), its free-form tags, a safe subtitle, and its derived Watchtower
 * status. Weak and reused are computed here from the passwords the server
 * holds; compromised is the one stored flag. Secrets NEVER ride this payload:
 * passwords, card numbers, CVVs, OTP seeds and note bodies are stripped —
 * only the single-item query returns them. `truncated` tells the UI older
 * items exist beyond the window. Everything comes from the vault; this app
 * holds no rows of its own.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

const FLAGS_SCHEME_URI = 'https://centraid.dev/schemes/flags';
const ITEM_TYPE = 'locker.item';

/** length + character-class score, 0..5; weak at ≤2 (mirrors the app meter). */
export function strengthScore(pw) {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 14) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return s;
}

/** A safe, secret-free subtitle for a list row. */
function subtitleOf(it) {
  switch (it.type) {
    case 'login':
      return it.username || '—';
    case 'card': {
      const digits = String(it.card_number || '').replace(/\s/g, '');
      return digits ? `•••• ${digits.slice(-4)}` : 'Card';
    }
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

/** Build the secret-free decorated rows for a set of raw item rows. */
export function decorate(rows, tagsByItem, starredIds) {
  // Reused: a login password that appears on ≥2 non-trashed logins.
  const pwCount = new Map();
  for (const it of rows) {
    if (it.type === 'login' && it.password)
      pwCount.set(it.password, (pwCount.get(it.password) || 0) + 1);
  }
  return rows.map((it) => {
    const pw =
      it.type === 'login' || it.type === 'wifi' || it.type === 'password' ? it.password : null;
    const weak = it.type === 'login' && !!it.password && strengthScore(it.password) <= 2;
    const reused = it.type === 'login' && !!it.password && (pwCount.get(it.password) || 0) >= 2;
    const compromised = it.compromised === 1 || it.compromised === true;
    const severity = compromised ? 'danger' : weak || reused ? 'warn' : '';
    return {
      item_id: it.item_id,
      type: it.type,
      title: it.title,
      subtitle: subtitleOf(it),
      favorite: starredIds.has(it.item_id),
      tags: tagsByItem.get(it.item_id) ?? [],
      weak,
      reused,
      compromised,
      severity,
      updated_at: it.updated_at,
      purge_at: it.purge_at ?? null,
      // silence unused-var lint intent: pw participates only in derivations
      _hasSecret: pw != null || undefined,
    };
  });
}

/** Read tags for a set of item ids into item_id → string[]. */
export async function readTags(ctx, ids, purpose) {
  const map = new Map();
  if (ids.length === 0) return map;
  const tags = await ctx.vault.read({
    entity: 'locker.item_tag',
    where: [{ column: 'item_id', op: 'in', value: ids }],
    purpose,
  });
  for (const t of tags.rows ?? []) {
    if (!map.has(t.item_id)) map.set(t.item_id, []);
    map.get(t.item_id).push(t.tag);
  }
  for (const arr of map.values()) arr.sort();
  return map;
}

/** Read the starred flag ids for a set of item ids (flags-scheme star). */
export async function readStarred(ctx, ids, purpose) {
  const starred = new Set();
  if (ids.length === 0) return starred;
  const [concepts, schemes] = await Promise.all([
    ctx.vault.read({ entity: 'core.concept', purpose }),
    ctx.vault.read({ entity: 'core.concept_scheme', purpose }),
  ]);
  const flagsScheme = (schemes.rows ?? []).find((s) => s.uri === FLAGS_SCHEME_URI);
  const starredConcept = flagsScheme
    ? (concepts.rows ?? []).find(
        (c) => c.scheme_id === flagsScheme.scheme_id && c.notation === 'starred',
      )
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
    const [tagsByItem, starredIds] = await Promise.all([
      readTags(ctx, ids, purpose),
      readStarred(ctx, ids, purpose),
    ]);
    const items = decorate(rows, tagsByItem, starredIds);
    return { items, truncated: rows.length >= window, window };
  } catch (err) {
    return { items: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
