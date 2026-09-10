// What the Library's selection bar SAYS. Pure, so the casing rule is
// assertable without a renderer (`photos-copy-case.test.ts` sweeps it).

/**
 * Sentence case, like every other string in Photos (#1015). It used to be
 * Title Case as "iOS Photos wording (#712)"; matching Apple's chrome inside a
 * product with its own voice bought nothing and cost the one casing rule the
 * rest of the app keeps, so #712 is superseded here.
 * Keep the `count === 0` branch — do not assume no caller.
 */
export function selectionCountLabel(count: number): string {
  if (count === 0) return "Select items";
  return `${count} ${count === 1 ? "photo" : "photos"} selected`;
}
