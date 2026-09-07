import { inList, readPages } from "../../_shared/paged-reads.ts";

interface TrashedProfile {
  party_id: string;
  role?: string | null;
  purge_at?: string | null;
}

interface Party {
  party_id: string;
  display_name: string;
}

/** How many trashed people the shelf shows. */
const TRASH_ROWS = 500;

/** Secret-free People trash shelf; canonical parties remain intact. */
export default async function trashPeople({ ctx }: HandlerArgs) {
  try {
    // The shelf is what the screen shows, so the read is the shelf's size.
    const profiles = await ctx.vault.page<TrashedProfile>({
      query: {
        name: "people.trash.profiles",
        select: "party_id, role, deleted_at, purge_at",
        from: "people_profile",
        where: "deleted_at IS NOT NULL",
        order: {
          sortColumn: "deleted_at",
          pkColumn: "party_id",
          descending: true,
        },
      },
      limit: TRASH_ROWS,
    });
    const rows = profiles.rows;
    const ids = rows.map((row) => row.party_id);
    const partyIn = ids.length === 0 ? null : inList("party_id", ids);
    const parties = partyIn
      ? await readPages<Party>(ctx, {
          name: "people.trash.parties",
          select: "party_id, display_name",
          from: "core_party",
          where: partyIn.sql,
          bind: partyIn.bind,
          order: {
            sortColumn: "party_id",
            pkColumn: "party_id",
            descending: false,
          },
        })
      : [];
    const names = new Map(
      parties.map((party) => [party.party_id, party.display_name])
    );
    return {
      people: rows.map((row) => ({
        party_id: row.party_id,
        name: names.get(row.party_id) ?? "—",
        role: row.role ?? "",
        purge_at: row.purge_at ?? null,
      })),
    };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      people: [],
      vaultDenied: { code: e.code, message: e.message },
    };
  }
}
