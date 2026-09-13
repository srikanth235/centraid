/*
 * The Tally dashboard's fold, over the catalogue's eleven named pages
 * (#1020, D-1020-F5).
 *
 * The **arithmetic is not here.** Who owes whom is `crates/apps/tally`'s
 * balance engine, already compared answer-for-answer with v0's own engine
 * against `contracts/apps/tally/balances.json` (lane D3). What this module does
 * is what a renderer is for: take the rows the seat served and put them in the
 * shape a screen draws — index by id, join by foreign key, count.
 *
 * Rows arrive **positionally**, in the order the statement's `select` named
 * (`row.proto`: "positional rather than a map because the caller named the
 * columns in the request"). So every read here goes through
 * [`byColumn`] rather than an index literal: a `select` that gains a column
 * shifts every literal after it, silently, and that is the one failure a
 * renderer cannot see.
 */

/** A page as the socket hands it over. */
export interface Page {
  columns: string[];
  rows: unknown[][];
  next?: { sort_key: string; pk: string };
}

/** One row as a keyed object. */
export type Record_ = Record<string, unknown>;

/**
 * Turn a positional page into keyed rows.
 *
 * A column the page did not carry is **absent**, not null: `value.proto` keeps
 * SQL NULL and "no such column" distinguishable on purpose (census seam 2), and
 * flattening them here would lose the distinction one layer below the screen.
 */
export function byColumn(page: Page | undefined): Record_[] {
  if (!page) return [];
  return page.rows.map((row) => {
    const keyed: Record_ = {};
    page.columns.forEach((column, index) => {
      if (index < row.length) keyed[column] = row[index];
    });
    return keyed;
  });
}

/**
 * An integer from a wire value.
 *
 * `{"i": "<decimal>"}` is how the socket carries an integer beyond
 * `Number.MAX_SAFE_INTEGER` — v0's `row-json.ts` escape, kept because a bare
 * number would be silently rounded. Money is minor units, so a vault with a
 * very large total is not hypothetical.
 */
export function asInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "object" && value !== null && "i" in value) {
    const parsed = Number((value as { i: unknown }).i);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function asText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export interface TallyDashboard {
  vaultId?: string;
  selfPartyId?: string;
  baseCurrency: string;
  friendCount: number;
  /** Live groups, archived excluded — the timeline's own rule. */
  groups: Array<{
    groupId: string;
    circleId?: string;
    name?: string;
    icon?: string;
    currency: string;
    memberCount: number;
    archived: boolean;
  }>;
  archivedGroupCount: number;
  expenseCount: number;
  settlementCount: number;
  openObligationCount: number;
  /** `true` when any page said there was more than it returned. */
  truncated: boolean;
}

/**
 * Fold the eleven pages into the dashboard.
 *
 * `truncated` is a first-class field and not a guess: the window IS the
 * promise, and a dashboard longer than one page is a dashboard that must say it
 * did not read all of it (`crates/apps/tally/src/queries.rs`'s note on
 * `expenses_statement`). A screen that silently showed a partial total would be
 * wrong in the one place a member checks arithmetic.
 */
export function foldDashboard(pages: {
  vault?: Page;
  friends?: Page;
  groups?: Page;
  circles?: Page;
  circleMembers?: Page;
  expenses?: Page;
  settlements?: Page;
  obligations?: Page;
}): TallyDashboard {
  const vault = byColumn(pages.vault)[0];
  const circles = new Map(
    byColumn(pages.circles).map((row) => [asText(row["circle_id"]) ?? "", row])
  );
  const membersPerCircle = new Map<string, number>();
  for (const member of byColumn(pages.circleMembers)) {
    const circleId = asText(member["circle_id"]);
    if (!circleId) continue;
    membersPerCircle.set(circleId, (membersPerCircle.get(circleId) ?? 0) + 1);
  }

  const allGroups = byColumn(pages.groups).map((row) => {
    const circleId = asText(row["circle_id"]);
    return {
      groupId: asText(row["group_id"]) ?? "",
      ...(circleId === undefined ? {} : { circleId }),
      name: circleId ? asText(circles.get(circleId)?.["name"]) : undefined,
      icon: asText(row["icon"]),
      // #996 R22: a group is one ledger in one money, so the currency is the
      // group's own and never inherited from the vault.
      currency:
        asText(row["currency"]) ?? asText(vault?.["base_currency"]) ?? "",
      memberCount: circleId ? (membersPerCircle.get(circleId) ?? 0) : 0,
      archived: row["archived_at"] !== null && row["archived_at"] !== undefined,
    };
  });

  const truncated = [
    pages.friends,
    pages.groups,
    pages.expenses,
    pages.settlements,
    pages.obligations,
  ].some((page) => page?.next !== undefined && page.next !== null);

  return {
    vaultId: asText(vault?.["vault_id"]),
    selfPartyId: asText(vault?.["self_party_id"]),
    baseCurrency: asText(vault?.["base_currency"]) ?? "",
    friendCount: byColumn(pages.friends).length,
    groups: allGroups.filter((group) => !group.archived),
    archivedGroupCount: allGroups.filter((group) => group.archived).length,
    expenseCount: byColumn(pages.expenses).length,
    settlementCount: byColumn(pages.settlements).length,
    openObligationCount: byColumn(pages.obligations).length,
    truncated,
  };
}

/** One asset in the Photos grid. */
export interface PhotoTile {
  assetId: string;
  contentId: string;
  kind: string;
  title?: string;
  capturedAt?: string;
  /** The `centraid://` URL, or `undefined` when no bytes are known yet. */
  src?: string;
  mediaType?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

/**
 * Join the three Photos pages into tiles.
 *
 * The join is in memory and not in SQL, and that is deliberate: `crates/core`'s
 * `api::page` reads each row value back **by the literal `select` entry**, so a
 * JOIN would need aliases and an alias there is a silent column of nulls
 * (`crates/centraid/src/cmd/seat/catalogue.rs`). Three bounded pages and a map
 * is the honest shape.
 */
export function foldPhotos(pages: {
  assets?: Page;
  content?: Page;
  representations?: Page;
}): PhotoTile[] {
  const content = new Map(
    byColumn(pages.content).map((row) => [asText(row["content_id"]) ?? "", row])
  );
  const representation = new Map<string, Record_>();
  for (const row of byColumn(pages.representations)) {
    const contentId = asText(row["content_id"]);
    // The FIRST representation wins, which is the order the statement asked
    // for; a later one is an alternative rendition of the same bytes.
    if (contentId && !representation.has(contentId))
      representation.set(contentId, row);
  }
  return byColumn(pages.assets).map((asset) => {
    const contentId = asText(asset["content_id"]) ?? "";
    const bytes = content.get(contentId);
    const sha = asText(bytes?.["sha256"]);
    return {
      assetId: asText(asset["asset_id"]) ?? "",
      contentId,
      kind: asText(asset["kind"]) ?? "photo",
      title: asText(asset["title"]),
      capturedAt: asText(asset["captured_at"]),
      src: sha ? blobUrl(sha) : undefined,
      mediaType: asText(representation.get(contentId)?.["media_type"]),
      width: asInteger(asset["width"]),
      height: asInteger(asset["height"]),
      durationSeconds:
        typeof asset["duration_s"] === "number"
          ? (asset["duration_s"] as number)
          : undefined,
    };
  });
}

/** The one place a `centraid://` URL is built. */
export function blobUrl(
  digest: string,
  options: { download?: boolean } = {}
): string {
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new Error("that is not a blob digest");
  }
  return `centraid://blob/${digest}${options.download ? "?download=1" : ""}`;
}
