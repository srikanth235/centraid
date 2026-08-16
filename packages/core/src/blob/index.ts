// Public barrel. The CBSF implementation lives in `cbsf.ts` so it is inside
// the repo-wide coverage scope: root `vitest.config.ts` excludes `**/index.ts`
// (barrels are re-export noise, not behaviour), which meant this package —
// whose entire source was a single `index.ts` — measured 0 instrumented lines
// and was invisible to every floor (issue #656 Layer 1F). Same shape as
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
