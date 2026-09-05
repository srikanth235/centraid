/**
 * The locker as a bounded recent window, decorated with
 * favorite/tag/subtitle/Watchtower. Secrets are SEALED columns (#293):
 * weak/reused + last4 come from `locker.watchtower`, derived INSIDE the
 * sealed boundary; secrets NEVER ride this payload.
 */

import {
  FLAGS_SCHEME_URI,
  LOCKER_TAGS_SCHEME_URI,
  STARRED_NOTATION,
  conceptsInScheme,
  findScheme,
  findSchemeConcept,
} from "../../_shared/concept-scheme-kit.ts";

export interface RawItem {
  item_id: string;
  type: string;
  title: string;
  username?: string | null;
  url?: string | null;
  email?: string | null;
  network?: string | null;
  expiry?: string | null;
  compromised?: number | boolean | null;
  password_set_at?: string | null;
  updated_at?: string;
  purge_at?: string | null;
  archived_at?: string | null;
  deleted_at?: string | null;
}

interface AliasRow {
  alias: string;
  item_id: string;
}

interface CountsPayload {
  live?: number;
  archived?: number;
  trashed?: number;
  by_type?: { type: string; n: number }[];
}

interface WatchEntry {
  item_id: string;
  weak?: boolean;
  reused?: boolean;
  last4?: string;
}

interface TagRow {
  concept_id: string;
  target_id: string;
}

interface ConceptRow {
  concept_id: string;
  scheme_id: string;
  pref_label?: string;
  notation?: string;
}

interface SchemeRow {
  scheme_id: string;
  uri: string;
}

interface ConceptTables {
  concepts: ConceptRow[];
  schemes: SchemeRow[];
}

interface DecoratedItem {
  item_id: string;
  type: string;
  title: string;
  subtitle: string;
  favorite: boolean;
  tags: string[];
  weak: boolean;
  reused: boolean;
  compromised: boolean;
  severity: string;
  /**
   * Plain TEXT columns, NOT sealed (see SEALED_INPUT/SEALED_COLUMNS in
   * packages/vault/src/commands/locker.ts: password, otp_seed, card_number,
   * cvv, content). The Review surface reads them off the list row to
   * self-heal, so carrying them here keeps the list payload secret-free.
   */
  url: string | null;
  expiry: string | null;
  updated_at?: string;
  purge_at: string | null;
  /** The connector alias (#298 item 4), read back from the registered
   *  `locker_item_alias` table (#872), so the form can pre-fill and show what a
   *  typed value would overwrite. */
  alias: string | null;
  /** Archived items are kept forever and hidden from the default window. */
  archived: boolean;
  /** When the CURRENT password was set — Review's password-age source. */
  password_set_at: string | null;
}

const ITEM_TYPE = "locker.item";

/** A safe, secret-free subtitle for a list row. */
function subtitleOf(it: RawItem, watch: WatchEntry | undefined): string {
  switch (it.type) {
    case "login":
      return it.username || "—";
    case "card":
      return watch?.last4 ? `•••• ${watch.last4}` : "Card";
    case "note":
      return "Secure note";
    case "identity":
      return it.email || "—";
    case "wifi":
      return it.network || "—";
    default:
      return "Password";
  }
}

/**
 * Watchtower derivatives per item id: {weak, reused, last4?} (#293) —
 * passwords never leave the sealed boundary. Fail-soft: no grant → empty map.
 */
export async function readWatchtower(
  ctx: HandlerCtx
): Promise<Map<string, WatchEntry>> {
  const map = new Map<string, WatchEntry>();
  try {
    const out = await ctx.vault.invoke({
      command: "locker.watchtower",
      input: {},
    });
    if (out.status !== "executed") return map;
    const entries = (out.output?.items ?? []) as WatchEntry[];
    for (const entry of entries) map.set(entry.item_id, entry);
  } catch {
    /* fail soft */
  }
  return map;
}

/** Build the secret-free decorated rows for a set of raw item rows. */
export function decorate(
  rows: RawItem[],
  tagsByItem: Map<string, string[]>,
  starredIds: Set<string>,
  watchByItem?: Map<string, WatchEntry>,
  aliasByItem?: Map<string, string>
): DecoratedItem[] {
  return rows.map((it) => {
    const watch = watchByItem?.get(it.item_id);
    const weak = !!watch?.weak;
    const reused = !!watch?.reused;
    const compromised = it.compromised === 1 || it.compromised === true;
    const severity = compromised ? "danger" : weak || reused ? "warn" : "";
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
      url: it.url ?? null,
      expiry: it.expiry ?? null,
      updated_at: it.updated_at,
      purge_at: it.purge_at ?? null,
      alias: aliasByItem?.get(it.item_id) ?? null,
      archived: it.archived_at != null,
      password_set_at: it.password_set_at ?? null,
    };
  });
}

/**
 * item_id → connector alias. Fail-soft: an app installed before the alias
 * scope existed keeps rendering its list with no alias rather than going dark.
 */
export async function readAliases(
  ctx: HandlerCtx,
  ids: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  try {
    const result = await ctx.vault.read({
      acceptTruncation: true,
      entity: "locker.item_alias",
      where: [{ column: "item_id", op: "in", value: ids }],
    });
    for (const row of (result.rows ?? []) as unknown as AliasRow[])
      map.set(row.item_id, row.alias);
  } catch {
    /* fail soft — an alias is a decoration, never the list itself */
  }
  return map;
}

/**
 * The vault's own COUNT, for "300 of 312 · the window is 300 by default and
 * 2,000 at most". Counted inside the vault rather than by reading the ceiling
 * back and calling `.length` on it — the foot line's whole job is to say how
 * much is beyond the window, so deriving it from the window would be circular.
 * Fail-soft: no counts means the foot line says nothing, never a wrong number.
 */
export async function readCounts(
  ctx: HandlerCtx
): Promise<CountsPayload | null> {
  try {
    const out = await ctx.vault.invoke({
      command: "locker.counts",
      input: {},
    });
    if (out.status !== "executed") return null;
    return (out.output ?? null) as CountsPayload | null;
  } catch {
    return null;
  }
}

/** Read the two SKOS vocabulary tables once, shared by readTags + readStarred (#404). */
export async function readConceptTables(
  ctx: HandlerCtx
): Promise<ConceptTables> {
  const [concepts, schemes] = await Promise.all([
    ctx.vault.read({ acceptTruncation: true, entity: "core.concept" }),
    ctx.vault.read({
      acceptTruncation: true,
      entity: "core.concept_scheme",
    }),
  ]);
  return {
    concepts: (concepts.rows ?? []) as unknown as ConceptRow[],
    schemes: (schemes.rows ?? []) as unknown as SchemeRow[],
  };
}

/** Read tags into item_id → string[] (locker-tags scheme); pass `tables` to share the read. */
export async function readTags(
  ctx: HandlerCtx,
  ids: string[],
  tables?: ConceptTables
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (ids.length === 0) return map;
  const vocab = tables ?? (await readConceptTables(ctx));
  const tags = await ctx.vault.read({
    acceptTruncation: true,
    entity: "core.tag",
    where: [
      { column: "target_type", op: "eq", value: ITEM_TYPE },
      { column: "target_id", op: "in", value: ids },
    ],
  });
  const tagScheme = findScheme(vocab.schemes, LOCKER_TAGS_SCHEME_URI);
  if (!tagScheme) return map;
  const labelByConcept = new Map(
    conceptsInScheme(vocab.concepts, tagScheme).map(
      (c) => [c.concept_id, c.pref_label] as const
    )
  );
  for (const t of (tags.rows ?? []) as unknown as TagRow[]) {
    const label = labelByConcept.get(t.concept_id);
    if (!label) continue; // a flags-scheme star, not a tag
    if (!map.has(t.target_id)) map.set(t.target_id, []);
    map.get(t.target_id)!.push(label);
  }
  for (const arr of map.values()) arr.sort();
  return map;
}

/** Read starred flag ids (flags-scheme star); pass `tables` to share the read. */
export async function readStarred(
  ctx: HandlerCtx,
  ids: string[],
  tables?: ConceptTables
): Promise<Set<string>> {
  const starred = new Set<string>();
  if (ids.length === 0) return starred;
  const vocab = tables ?? (await readConceptTables(ctx));
  const starredConcept = findSchemeConcept(
    vocab.schemes,
    vocab.concepts,
    FLAGS_SCHEME_URI,
    STARRED_NOTATION
  );
  if (!starredConcept) return starred;
  const tags = await ctx.vault.read({
    acceptTruncation: true,
    entity: "core.tag",
    where: [
      { column: "concept_id", op: "eq", value: starredConcept.concept_id },
      { column: "target_type", op: "eq", value: ITEM_TYPE },
      { column: "target_id", op: "in", value: ids },
    ],
  });
  for (const t of (tags.rows ?? []) as unknown as TagRow[])
    starred.add(t.target_id);
  return starred;
}

export default async function itemsHandler({
  input,
  ctx,
}: {
  input?: Record<string, unknown>;
  ctx: HandlerCtx;
}) {
  const window = Math.min(Math.max(Number(input?.limit) || 300, 20), 2000);
  try {
    const authentication = (await ctx.vault.authenticate({
      operation: "status",
      sessionToken: String(input?.auth_session ?? ""),
    })) as { authenticated?: boolean; configured?: boolean };
    if (!authentication.authenticated) {
      return {
        items: [],
        authRequired: true,
        configured: authentication.configured ?? false,
      };
    }
    // Archived is "keep forever, hide from lists" (GAPS §3.3 #9): it leaves
    // the default window without being deleted and without a purge date, so
    // the shelf is asked for explicitly rather than filtered client-side.
    const archived = input?.archived === true;
    const res = await ctx.vault.read({
      entity: "locker.item",
      where: [
        { column: "deleted_at", op: "is-null" },
        archived
          ? { column: "archived_at", op: "not-null" }
          : { column: "archived_at", op: "is-null" },
      ],
      orderBy: { column: "updated_at", dir: "desc" },
      limit: window,
    });
    const rows = (res.rows ?? []) as unknown as RawItem[];
    const ids = rows.map((r) => r.item_id);
    // One shared vocabulary read + ONE watchtower unseal (#404) — not a
    // second full read and second receipted unseal.
    const vocab = await readConceptTables(ctx);
    const [tagsByItem, starredIds, watchByItem, aliasByItem, counts] =
      await Promise.all([
        readTags(ctx, ids, vocab),
        readStarred(ctx, ids, vocab),
        readWatchtower(ctx),
        readAliases(ctx, ids),
        readCounts(ctx),
      ]);
    const items = decorate(
      rows,
      tagsByItem,
      starredIds,
      watchByItem,
      aliasByItem
    );
    const affected = items.filter(
      (it) => it.compromised || it.weak || it.reused
    );
    const watchtower = {
      compromised: items.filter((it) => it.compromised).length,
      weak: items.filter((it) => it.weak).length,
      reused: items.filter((it) => it.reused).length,
      items: affected,
    };
    const total = archived ? counts?.archived : counts?.live;
    return {
      items,
      watchtower,
      truncated: rows.length >= window,
      window,
      archived,
      ...(total == null ? {} : { total }),
      ...(counts?.by_type ? { byType: counts.by_type } : {}),
      ...(counts?.archived == null ? {} : { archivedCount: counts.archived }),
      ...(counts?.trashed == null ? {} : { trashedCount: counts.trashed }),
    };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { items: [], vaultDenied: { code: e.code, message: e.message } };
  }
}
