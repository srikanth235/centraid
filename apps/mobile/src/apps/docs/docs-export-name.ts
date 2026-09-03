export const EXPORT_FOLDER = "docs-export";

export function exportName(title: string): string {
  let leaf = "";
  for (const part of title.split(/[/\\]+/u)) {
    if (part !== "" && part !== "." && part !== "..") leaf = part;
  }
  const safe = leaf.replace(/[:*?"<>|]+/gu, " ").trim();
  return safe || "document";
}
