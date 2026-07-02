// Semantic primitives (ontology layer L0): UUIDv7 identifiers (time-ordered,
// offline-mintable), ISO-8601 UTC instants, sha256 content hashes.

import { createHash } from 'node:crypto';

/** Mint a UUIDv7 — monotonic within a millisecond, so PK order is insert order. */
export { v7 as uuidv7 } from 'uuid';

/** Current instant as ISO-8601 UTC — the only timestamp format stored. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** sha256 as lowercase hex — receipt chaining and content identity. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
