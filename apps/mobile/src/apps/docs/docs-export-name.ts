// Share-sheet leaf name. The title is interpolated into a cache path, so
// separators and `..` segments must not survive.

export const EXPORT_FOLDER = "docs-export";

/** A cache-safe file name that keeps the member's own title (and its
 *  extension, which is what the receiving app keys off). */
export function exportName(title: string): string {
  let leaf = "";
  for (const part of title.split(/[/\\]+/u)) {
    if (part !== "" && part !== "." && part !== "..") leaf = part;
  }
  const safe = leaf.replace(/[:*?"<>|]+/gu, " ").trim();
  return safe || "document";
}
