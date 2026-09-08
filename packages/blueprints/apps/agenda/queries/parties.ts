/**
 * The invite directory: the people the create-event picker can invite as
 * attendees. Just canonical `core.party` rows of kind `person`, projected to
 * `{ party_id, name, is_you }` with the owner (the vault's `self_party_id`)
 * sorted first and flagged — the app holds no roster of its own. Agents, orgs
 * and groups are left out: an invitation is a commitment asked of a person.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders it
 * as the "ask the owner for access" state.
 */
import { readPages } from "../../_shared/paged-reads.ts";

interface RawParty {
  party_id: string;
  display_name?: string;
  [k: string]: unknown;
}

export default async function partiesHandler({ ctx }: HandlerArgs) {
  try {
    // The owner is the implicit `me` (same source Tally reads) — everyone
    // else in the directory is a peer who could be invited.
    const [vaultRows, partyRows] = await Promise.all([
      readPages<{ vault_id: string; self_party_id?: string | null }>(ctx, {
        name: "agenda.parties.vault",
        select: "vault_id, self_party_id",
        from: "core_vault",
        order: {
          sortColumn: "vault_id",
          pkColumn: "vault_id",
          descending: false,
        },
      }),
      // A directory is owner-curated: a walk with a stated ceiling, not a
      // window nobody chose (#996 wave 4, R8).
      readPages<RawParty>(ctx, {
        name: "agenda.parties.people",
        select: "party_id, display_name, kind",
        from: "core_party",
        where: "kind = ?",
        bind: ["person"],
        order: {
          sortColumn: "party_id",
          pkColumn: "party_id",
          descending: false,
        },
      }),
    ]);
    const me = vaultRows[0]?.self_party_id ?? null;
    const parties = partyRows
      .map((p) => ({
        party_id: p.party_id,
        name: p.display_name ?? "Guest",
        is_you: p.party_id === me,
      }))
      .toSorted(
        (a, b) =>
          (b.is_you ? 1 : 0) - (a.is_you ? 1 : 0) ||
          String(a.name).localeCompare(String(b.name))
      );
    return { parties, me };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      parties: [],
      me: null,
      vaultDenied: { code: e.code, message: e.message },
    };
  }
}
