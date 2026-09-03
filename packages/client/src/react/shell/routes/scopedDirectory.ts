const MAX_SCOPED_DIRECTORIES = 8;

function isAbsolutePath(directory: string): boolean {
  return (
    directory.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(directory) ||
    directory.startsWith("\\\\")
  );
}

export function rejectScopedDirectory(
  directory: string,
  existing: readonly string[]
): string | null {
  if (!isAbsolutePath(directory)) {
    return `"${directory}" is not an absolute path — share a full path like /Users/you/project.`;
  }
  if (existing.includes(directory))
    return `"${directory}" is already shared with this harness.`;
  if (existing.length >= MAX_SCOPED_DIRECTORIES) {
    return `At most ${MAX_SCOPED_DIRECTORIES} folders can be shared with one conversation.`;
  }
  return null;
}
