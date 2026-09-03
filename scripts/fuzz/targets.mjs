import { PROTOCOL_TARGETS } from "./targets-protocol.mjs";
import { SEARCH_TARGETS } from "./targets-search.mjs";
import { STORAGE_TARGETS } from "./targets-storage.mjs";

export { FuzzInvariantError, invariant } from "./targets-support.mjs";

export const FUZZ_TARGETS = [
  ...PROTOCOL_TARGETS,
  ...STORAGE_TARGETS,
  ...SEARCH_TARGETS,
];

export function targetById(id) {
  const target = FUZZ_TARGETS.find((entry) => entry.id === id);
  if (!target) throw new Error(`fuzz: unknown target "${id}"`);
  return target;
}
