/**
 * Fuzz target catalog (#839 G10).
 *
 * A target is a parser or expression compiler that eats bytes somebody else
 * chose — a wire frame, a QR payload, an object key from a storage provider, a
 * search box. Each entry names the entry function, the committed seed corpus,
 * and the *invariant*: the property that must hold for every input, not just
 * the ones we thought of.
 *
 * Every invariant is stated as `invariant(condition, class, message)`. The
 * `class` is the finding's identity: `scripts/fuzz/known-findings.json` is
 * keyed by it, so a divergence we have already recorded is reported without
 * failing the lane while anything new fails it. Inputs are always bytes — the
 * per-target `run` decodes them, which is where the structure-awareness lives.
 *
 * The catalog aggregates three per-domain modules; the shared invariant
 * primitives and module-resolution helpers live in `targets-support.mjs`. This
 * file stays the single import surface: `FUZZ_TARGETS`, `targetById`, and the
 * re-exported `invariant` / `FuzzInvariantError` are what `run.mjs` and
 * `replay.test.mjs` consume.
 */
import { PROTOCOL_TARGETS } from "./targets-protocol.ts";
import { SEARCH_TARGETS } from "./targets-search.ts";
import { STORAGE_TARGETS } from "./targets-storage.ts";
import type { FuzzTarget } from "./targets-support.ts";

export { FuzzInvariantError, invariant } from "./targets-support.ts";
export type { FuzzTarget } from "./targets-support.ts";

export const FUZZ_TARGETS: FuzzTarget[] = [
  ...PROTOCOL_TARGETS,
  ...STORAGE_TARGETS,
  ...SEARCH_TARGETS,
];

/**
 * Look up a target by id.
 * @param {string} id Target id.
 * @returns {FuzzTarget} The target.
 */
export function targetById(id: string): FuzzTarget {
  const target = FUZZ_TARGETS.find((entry) => entry.id === id);
  if (!target) throw new Error(`fuzz: unknown target "${id}"`);
  return target;
}
