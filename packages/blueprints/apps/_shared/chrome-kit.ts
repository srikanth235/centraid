// APP-CHROME RULES WITH NO MARKUP IN THEM (#883 B9).
//
// Split from `AppChrome.tsx` the way `search-scaffold.ts` is split from
// `SearchScaffold.tsx`. What is here is the one arithmetic every app's chrome
// did by hand: turning a set of state flags into the shell element's class
// list. Eight copies of `[…].filter(Boolean).join(" ")` is eight chances to
// get the empty-string case wrong.

/**
 * The shell element's class list. Falsy parts drop out, so a caller writes
 * `chromeClass(styles.shell, narrow && styles.isNarrow)` and never a `""`.
 */
export function chromeClass(
  ...parts: readonly (string | false | null | undefined)[]
): string {
  return parts.filter((part): part is string => Boolean(part)).join(" ");
}
