// SENTENCE CASE, SWEPT (#1015, D2/S11). Every app owns a copy table, and a
// Title Case label is the one drift that arrives a word at a time — a menu
// row here, a chip there — until an app ships two casing systems. Photos
// wrote this check first (`apps/photos/photos-copy-case.test.ts`); it lives
// here so each app's sweep is the SAME check with its own proper nouns
// rather than four near-copies that drift apart.

/**
 * The capitalised words after the first that name nothing — proper nouns and
 * the app's own place names are passed in, because "Trash" is a place in
 * Photos and a verb in Docs, and only the app knows which.
 *
 * Empty means the label is sentence case.
 */
export function titleCaseWords(
  label: string,
  properNouns: ReadonlySet<string>
): string[] {
  // A refusal rides after an em dash; that clause is its own sentence, and a
  // capital opening it is the sentence's own, not Title Case.
  return label.split("—").flatMap((clause) =>
    clause
      .trim()
      .split(/\s+/u)
      .slice(1)
      .filter(
        (word) =>
          /^[A-Z][a-z]/u.test(word) &&
          !properNouns.has(word.replace(/[.,:;?]$/u, ""))
      )
  );
}
