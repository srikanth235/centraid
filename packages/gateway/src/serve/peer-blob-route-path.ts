/*
 * Shared between the server handler (`routes/peer-blob-route.ts`) and the
 * client puller (`peer-blob-pull.ts`) so neither imports the other just for
 * a path string.
 */
export const PEER_BLOB_CHUNK_PATH = "/centraid/_peer/blob/chunk";
