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
  url: string | null;
  expiry: string | null;
  updated_at?: string;
  purge_at: string | null;
  alias: string | null;
  archived: boolean;
  password_set_at: string | null;
}

const ITEM_TYPE = "locker.item";

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

export async function readWatchtower(
  ctx: HandlerCtx,
  purpose: string
): Promise<Map<string, WatchEntry>> {
  const map = new Map<string, WatchEntry>();
  try {
    const out = await ctx.vault.invoke({
      command: "locker.watchtower",
      input: {},
      purpose,
    });
    if (out.status !== "executed") return map;
    const entries = (out.output?.items ?? []) as WatchEntry[];
    for (const entry of entries) map.set(entry.item_id, entry);
  } catch {
    // Intentionally empty.
  }
  return map;
}

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

export async function readAliases(
  ctx: HandlerCtx,
  ids: string[],
  purpose: string
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  try {
    const result = await ctx.vault.read({
      entity: "locker.item_alias",
      where: [{ column: "item_id", op: "in", value: ids }],
      purpose,
    });
    for (const row of (result.rows ?? []) as unknown as AliasRow[])
      map.set(row.item_id, row.alias);
  } catch {
    // Intentionally empty.
  }
  return map;
}

export async function readCounts(
  ctx: HandlerCtx,
  purpose: string
): Promise<CountsPayload | null> {
  try {
    const out = await ctx.vault.invoke({
      command: "locker.counts",
      input: {},
      purpose,
    });
    if (out.status !== "executed") return null;
    return (out.output ?? null) as CountsPayload | null;
  } catch {
    return null;
  }
}

export async function readConceptTables(
  ctx: HandlerCtx,
  purpose: string
): Promise<ConceptTables> {
  const [concepts, schemes] = await Promise.all([
    ctx.vault.read({ entity: "core.concept", purpose }),
    ctx.vault.read({ entity: "core.concept_scheme", purpose }),
  ]);
  return {
    concepts: (concepts.rows ?? []) as unknown as ConceptRow[],
    schemes: (schemes.rows ?? []) as unknown as SchemeRow[],
  };
}

export async function readTags(
  ctx: HandlerCtx,
  ids: string[],
  purpose: string,
  tables?: ConceptTables
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (ids.length === 0) return map;
  const vocab = tables ?? (await readConceptTables(ctx, purpose));
  const tags = await ctx.vault.read({
    entity: "core.tag",
    where: [
      { column: "target_type", op: "eq", value: ITEM_TYPE },
      { column: "target_id", op: "in", value: ids },
    ],
    purpose,
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

export async function readStarred(
  ctx: HandlerCtx,
  ids: string[],
  purpose: string,
  tables?: ConceptTables
): Promise<Set<string>> {
  const starred = new Set<string>();
  if (ids.length === 0) return starred;
  const vocab = tables ?? (await readConceptTables(ctx, purpose));
  const starredConcept = findSchemeConcept(
    vocab.schemes,
    vocab.concepts,
    FLAGS_SCHEME_URI,
    STARRED_NOTATION
  );
  if (!starredConcept) return starred;
  const tags = await ctx.vault.read({
    entity: "core.tag",
    where: [
      { column: "concept_id", op: "eq", value: starredConcept.concept_id },
      { column: "target_type", op: "eq", value: ITEM_TYPE },
      { column: "target_id", op: "in", value: ids },
    ],
    purpose,
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
  const purpose = "dpv:ServiceProvision";
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
      purpose,
    });
    const rows = (res.rows ?? []) as unknown as RawItem[];
    const ids = rows.map((r) => r.item_id);
    const vocab = await readConceptTables(ctx, purpose);
    const [tagsByItem, starredIds, watchByItem, aliasByItem, counts] =
      await Promise.all([
        readTags(ctx, ids, purpose, vocab),
        readStarred(ctx, ids, purpose, vocab),
        readWatchtower(ctx, purpose),
        readAliases(ctx, ids, purpose),
        readCounts(ctx, purpose),
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
