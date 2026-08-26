// Public barrel. The CBSF implementation lives in `cbsf.ts` so it is inside
// the repo-wide coverage scope: root `vitest.config.ts` excludes `**/index.ts`
// (barrels are re-export noise, not behaviour), so a package whose entire
// source is a single `index.ts` measures 0 instrumented lines and is
// invisible to every floor (#656 Layer 1F). Same shape as
// `packages/core/src/protocol`. Keep this file re-exports only.
export {
  BLOB_MEDIUM_EDGE,
  BLOB_TINY_EDGE,
  CBSF_HEADER_BYTES,
  CBSF_MAGIC,
  CBSF_NONCE_BYTES,
  CBSF_TRAILER_BYTES,
  CBSF_VERSION,
  cbsfDirectoryAad,
  cbsfFrameAad,
  decodeCbsfDirectory,
  encodeCbsfDirectory,
} from "./cbsf.js";
