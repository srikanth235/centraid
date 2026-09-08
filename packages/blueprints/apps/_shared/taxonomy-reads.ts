/**
 * THE TAXONOMY PAIR, DECLARED ONCE (#922 0a).
 *
 * Eight query handlers across Docs, Notes and People open the same way: read
 * every `core.concept`, read every `core.concept_scheme`, and hand both to
 * `concept-scheme-kit` to resolve tags into labelled shelves. The pair was
 * copy-pasted before this issue and stayed invisible; adding the explicit
 * `acceptTruncation` flag to each copy turned it into duplicated NEW code,
 * which is the honest reading — a bound restated in eight files is eight
 * places to forget when the window changes.
 *
 * Two reads, not one: they are different entities and each carries its own
 * truncation verdict, so the honesty line still fires per read exactly as it
 * did when the calls were written out. The helper returns the promises
 * UNAWAITED so a caller can keep them inside the `Promise.all` it already has,
 * in the position its destructuring expects.
 *
 * Unbounded by declaration, not by accident: a vault's concept vocabulary is
 * owner-curated and small — it is what BOUNDS the rest of these queries — so
 * the pair takes the default window knowingly and says so if it ever fills.
 */
export function conceptTaxonomyReads(
  vault: VaultApi
): [Promise<VaultReadResult>, Promise<VaultReadResult>] {
  return [
    vault.read({ acceptTruncation: true, entity: "core.concept" }),
    vault.read({
      acceptTruncation: true,
      entity: "core.concept_scheme",
    }),
  ];
}
