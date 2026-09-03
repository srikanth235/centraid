import { docSnipLine } from "@centraid/design/blocks";

export type { DocRowAction } from "@centraid/design/blocks";

export interface DocRecord {
  key: string;
  title: string;
  kind: string;
  written: string;
}

export function snipLine(record: DocRecord): string {
  return docSnipLine(record.kind, record.written);
}
