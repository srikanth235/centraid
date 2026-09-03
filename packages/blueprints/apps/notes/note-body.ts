import { decodeDataUri } from "../_shared/format-kit.ts";

export function decodeNoteBody(uri: unknown): string {
  if (typeof uri !== "string" || !uri.startsWith("data:"))
    return "(external content)";
  return decodeDataUri(uri) ?? "(unreadable content)";
}
