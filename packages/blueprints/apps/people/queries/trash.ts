interface TrashedProfile {
  // Carried through so `restore-person`'s pending-write overlay (issue #738,
  // see pending-projection.ts) can key its optimistic upsert on people.profile's
  // real primary key instead of the party_id the command's own input uses.
  profile_id: string;
  party_id: string;
  role?: string | null;
  purge_at?: string | null;
}

interface Party {
  party_id: string;
  display_name: string;
}

/** Secret-free People trash shelf; canonical parties remain intact. */
export default async function trashPeople({ ctx }: HandlerArgs) {
  const purpose = "dpv:ServiceProvision";
  try {
    const profiles = await ctx.vault.read({
      entity: "people.profile",
      where: [{ column: "deleted_at", op: "not-null" }],
      orderBy: { column: "deleted_at", dir: "desc" },
      limit: 500,
      purpose,
    });
    const rows = (profiles.rows ?? []) as unknown as TrashedProfile[];
    const ids = rows.map((row) => row.party_id);
    const parties =
      ids.length === 0
        ? { rows: [] }
        : await ctx.vault.read({
            entity: "core.party",
            where: [{ column: "party_id", op: "in", value: ids }],
            purpose,
          });
    const names = new Map(
      ((parties.rows ?? []) as unknown as Party[]).map((party) => [
        party.party_id,
        party.display_name,
      ])
    );
    return {
      people: rows.map((row) => ({
        party_id: row.party_id,
        profile_id: row.profile_id,
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
