// Share-sheet leaf name. The title is interpolated into a cache path, so
// separators and `..` segments must not survive.
export const EXPORT_FOLDER = "docs-export";

export function exportName(title: string): string {
  let leaf = "";
  for (const part of title.split(/[/\\]+/u)) {
    if (part !== "" && part !== "." && part !== "..") leaf = part;
  }
  const safe = leaf.replace(/[:*?"<>|]+/gu, " ").trim();
  return safe || "document";
}
