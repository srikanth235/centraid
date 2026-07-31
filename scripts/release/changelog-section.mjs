/**
 * Extract the body of one `## [<heading>]` section from a Keep a Changelog file.
 *
 * The terminator must be "the next `## ` heading, or end of input". Writing that
 * as `(?=^##\s+|$)` is wrong: the `m` flag needed for `^##` also makes `$` match
 * at every line end, so the lazy body capture terminates on the first newline and
 * always yields "". `(?![\s\S])` is end-of-input regardless of `m`.
 */

/**
 * @param {string} text Full changelog contents.
 * @param {string} heading Version string (e.g. "0.2.0") or "Unreleased".
 * @returns {string | null} Section body, or null when the section is absent.
 */
export function changelogSectionBody(text, heading) {
  const escaped = String(heading).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const re = new RegExp(
    `^##\\s+\\[?${escaped}\\]?[^\\n]*\\n(?<body>[\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`,
    "mu"
  );
  const match = text.match(re);
  return match ? (match.groups?.body ?? "") : null;
}
