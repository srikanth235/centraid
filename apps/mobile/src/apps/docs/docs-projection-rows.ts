export type EntityRow = Readonly<Record<string, unknown>>;

export const FOLDER_SCHEME_URI = "https://centraid.dev/schemes/folders";
export const FLAGS_SCHEME_URI = "https://centraid.dev/schemes/flags";
export const TAGS_SCHEME_URI = "centraid:tags:v1";
export const DOCUMENT_TARGET_TYPE = "core.document";
export const FOLDER_CONTAINER_TYPE = "docs.folder";

export const str = (row: EntityRow, key: string): string | null => {
  const value = row[key];
  return typeof value === "string" ? value : null;
};

export const num = (row: EntityRow, key: string): number | null => {
  const value = row[key];
  return typeof value === "number" ? value : null;
};

export function folderChain(
  conceptId: string | null,
  parentOf: Map<string, string | null>
): string[] {
  const chain: string[] = [];
  let at = conceptId ?? undefined;
  while (at && !chain.includes(at) && chain.length < 64) {
    chain.push(at);
    at = parentOf.get(at) ?? undefined;
  }
  return chain;
}
