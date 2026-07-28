/**
 * Escape regex special characters in a string so it can be safely interpolated
 * into a `new RegExp(...)` pattern.  CodeQL flags `js/regex-injection` when a
 * user-supplied value (here, a version string) is spliced into a regex without
 * escaping — this helper is the single canonical fix.
 *
 * @param {string} string
 * @returns {string}
 */
export function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
