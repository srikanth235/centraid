/**
 * The reserved keys of `tests/journeys.json#rigs` (#927).
 *
 * `rigs` is a map from RIG PATH to that rig's lane, volume and budget, and
 * every reader that walks it treats a key as a file it can stat. It is also a
 * ratcheted section, so `scripts/check-ledgers.mjs` requires the waiver for a
 * budget removal to sit in the SECTION being widened — `rigs.approvedDeviation`
 * — and a neighbouring section's note never waives. Those two facts collide
 * unless the walkers agree that a waiver is not a rig: without this list,
 * declaring the waiver `check-ledgers` demands makes `validate-nightly-wiring`
 * report `approvedDeviation` as a registered rig whose file is missing.
 *
 * Reserved rather than `_`-prefixed because `check-ledgers` reads the key by
 * its exact name; `_comment` is included for the same reason every other ledger
 * section carries one.
 */
export const RESERVED_RIG_KEYS = new Set(["approvedDeviation", "_comment"]);

/**
 * The rig paths declared in a `tests/journeys.json#rigs` map, with the reserved
 * metadata keys removed. Every caller that stats a key must read it through
 * here rather than `Object.keys`.
 * @param {Record<string, unknown> | undefined} rigs the `rigs` map
 * @returns {string[]} the declared rig paths, in declaration order
 */
export function rigPaths(rigs) {
  return Object.keys(rigs ?? {}).filter((key) => !RESERVED_RIG_KEYS.has(key));
}
