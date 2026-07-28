// Client-side gate on the scoped-workspace folders an assistant turn shares
// (#567). The gateway is the authority — `parseAdditionalDirectories` realpaths
// each root, rejects non-directories and the filesystem root, and caps the list
// at eight — but it only speaks on the NEXT turn, as a 400 that surfaces as a
// failed answer. These are the rules we can state at add time, in the prompt,
// where the user can still fix the typo.

/** The gateway's cap on shared roots (`parseAdditionalDirectories`). */
const MAX_SCOPED_DIRECTORIES = 8;

/** True for a POSIX (`/x`), Windows (`C:\x`), or UNC (`\\host\share`) root. */
function isAbsolutePath(directory: string): boolean {
  return (
    directory.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(directory) ||
    directory.startsWith("\\\\")
  );
}

/**
 * Why this folder can't join the turn's shared roots, or `null` when it can.
 * The string is user-facing.
 */
export function rejectScopedDirectory(
  directory: string,
  existing: readonly string[]
): string | null {
  if (!isAbsolutePath(directory)) {
    return `"${directory}" is not an absolute path — share a full path like /Users/you/project.`;
  }
  if (existing.includes(directory))
    return `"${directory}" is already shared with this agent.`;
  if (existing.length >= MAX_SCOPED_DIRECTORIES) {
    return `At most ${MAX_SCOPED_DIRECTORIES} folders can be shared with one conversation.`;
  }
  return null;
}
