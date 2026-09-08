// THE CUSTODY PROJECTION, AS A PAGE (#996 wave 4b, engine B).
//
// `blob_custody_state` is named here and nowhere under `apps/`. Engine B
// (`scripts/lint-engine-conformance.mjs`) forbids a mobile app from reaching
// the projection; `custody-status.ts` is the gateway rollup door, and this
// file is the seat-file door — per-content-id state for a drive that is
// already showing those bytes. Docs imports the query; it does not name the
// table.

import type { PageQuery } from "@centraid/core/page";

/** The bytes some document on this drive currently reads as its own. */
const CURRENT_DOCUMENT_BYTES = (column: string): string =>
  `${column} IN (SELECT current_content_id FROM core_document
     WHERE current_content_id IS NOT NULL)`;

export const DOCS_CUSTODY: PageQuery = {
  name: "phone.docs.custody",
  select: "content_id, sha256, custody_state, checked_at",
  from: "blob_custody_state",
  where: CURRENT_DOCUMENT_BYTES("content_id"),
  order: {
    sortColumn: "content_id",
    pkColumn: "content_id",
    descending: false,
  },
};
