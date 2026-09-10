// THE ONE CATEGORY TABLE (#1015 Wave 3, S11; tally/findings #11).
//
// The nine were written out twice — once in `draft-model.ts` for the composer's
// chips and once in `spending-model.ts` for the breakdown's rows — and a third
// surface, the expense record, printed no label at all: it rendered the vault's
// own key, so one saved expense read `Fun` on the chip that entered it and
// `fun` on the row that recorded it. A label is a presentation of an enum, and
// an enum gets exactly one label table per app.
//
// NINE, CLOSED. A tenth is a schema change, not a preference: this restates
// `tally.add_expense`'s `CATEGORY_ENUM` and the interface must not offer more.

/** The closed nine, in the vault's own order. */
export const CATEGORIES: readonly (readonly [string, string])[] = [
  ["food", "Food"],
  ["groceries", "Groceries"],
  ["rent", "Rent"],
  ["utilities", "Utilities"],
  ["transport", "Transport"],
  ["fun", "Fun"],
  ["travel", "Travel"],
  ["shopping", "Shopping"],
  ["general", "General"],
];

const BY_KEY = new Map(CATEGORIES);

/** The member-facing word for a stored category key. An unknown key is shown
 *  as itself rather than hidden: a category the vault holds and this table does
 *  not know about is a fact, and a blank cell would deny it. */
export function categoryLabel(key: string): string {
  return BY_KEY.get(key) ?? key;
}
