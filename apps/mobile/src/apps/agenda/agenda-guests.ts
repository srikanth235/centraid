// Who may be invited to an event (#1015, audit agenda/findings#2).
//
// `core_party` holds `kind IN ('person','org','group','agent','animal')` and
// the Agenda query has always selected `kind` — the two guest pickers simply
// mapped every row to a chip. So a new event offered "Photo OCR", "Face
// recognition" and "Text embeddings" as guests: eight of eighteen chips were
// the vault's own enrichment runners, and tapping one wrote a real attendee
// row. A guest is a PERSON; the other kinds are not people you invite.
//
// Pure, and shared by the composer and the editor, so the two forms cannot
// offer different sets for the same record.

export type PartyRow = Record<string, unknown>;

export interface GuestOption {
  id: string;
  name: string;
}

/** `core_party.kind` for a human. The only kind an attendee row may name. */
export const GUEST_KIND = "person";

const text = (row: PartyRow, key: string): string => {
  const value = row[key];
  return typeof value === "string" ? value : "";
};

/** People only, named by their display name, ordered by the sort name the
 *  vault keeps for exactly this. */
export function guestOptions(parties: readonly PartyRow[]): GuestOption[] {
  return parties
    .flatMap((party): { option: GuestOption; sort: string }[] => {
      if (text(party, "kind") !== GUEST_KIND) return [];
      const id = text(party, "party_id");
      if (!id) return [];
      const name = text(party, "display_name") || text(party, "name");
      return [
        {
          option: { id, name: name || "Person" },
          sort: text(party, "sort_name") || name,
        },
      ];
    })
    .sort((left, right) => left.sort.localeCompare(right.sort))
    .map((entry) => entry.option);
}
