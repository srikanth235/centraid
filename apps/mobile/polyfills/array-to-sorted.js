// `Array.prototype.toSorted`, for Hermes.
//
// Static Hermes 250829098.0.16 — the engine this app bundles — ships the rest
// of the ES2023 change-array-by-copy family (`toReversed`, `toSpliced`,
// `with`, `findLast`) but NOT `toSorted`; the upstream PR adding it has been
// open since February 2024 and is absent from the next stable, so there is no
// engine bump to wait for.
//
// Blueprints hit it because their view-level code runs BOTH on the Node
// gateway, where it exists, and on-device against the consent-scoped replica,
// where it does not (`apps/docs/filters.ts` sorts share audiences this way).
//
// Copy-then-sort is the whole implementation, and it is correct here: the spec
// requires a stable sort, and Hermes' own `sort` was measured stable on this
// engine before this was written.

"use strict";

if (!Array.prototype.toSorted) {
  // Defining the missing prototype method IS what a polyfill is; the header
  // says why Hermes needs this one and what would retire it.
  // oxlint-disable-next-line no-extend-native -- see above
  Object.defineProperty(Array.prototype, "toSorted", {
    configurable: true,
    // Never enumerable: an own enumerable property on Array.prototype would
    // show up in every `for...in` over an array in the app.
    enumerable: false,
    writable: true,
    // The name is the point: `Array.prototype.toSorted.name` must read
    // "toSorted" the way the real one does.
    // oxlint-disable-next-line func-name-matching -- see above
    value: function toSorted(compareFn) {
      if (compareFn !== undefined && typeof compareFn !== "function") {
        throw new TypeError(
          "The comparison function must be either a function or undefined"
        );
      }
      // `slice.call` rather than a spread: it accepts array-likes, which is
      // what the spec's indexed-object coercion produces, and turns holes into
      // `undefined` exactly as `toSorted` specifies.
      return Array.prototype.slice.call(this).sort(compareFn);
    },
  });
}
