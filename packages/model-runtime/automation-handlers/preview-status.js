// "Pending" and "unsupported" are the same silence from `ctx.vault.content`.
//
// A display rung that has not landed yet and one the codec DECLINED both answer
// `no-variant`, and a recipe that cannot tell them apart must assume the first:
// it parks its cursor before the asset and comes back next tick. That is right
// for a rung still in flight and catastrophic for a HEIC libheif refuses — the
// walk never gets past it, so the rest of the library is never recognised at
// all (#1011).
//
// The vault records the decline durably instead, as an `enrich_derivation`
// stamp on the content: variant `preview`, capability `previews`, and a model
// id naming the codec generation that declined (`packages/vault/src/blob/
// preview.ts`). The vault owns the version keying — a codec bump makes every
// marker stale and the backstop re-evaluates, retiring the marker the moment a
// rung lands — so a recipe asks only the one question it needs answered here:
// is this original previewable at all?

/**
 * True when the vault has recorded that no codec generation in service can
 * produce a display rung for this content. Such an asset is SKIPPED — counted,
 * logged, and walked PAST — never parked behind.
 */
export async function previewUnsupported(ctx, contentId) {
  if (!contentId) return false;
  const stamps = await ctx.vault.read({
    entity: "enrich.derivation",
    where: [
      { column: "target_id", op: "eq", value: contentId },
      { column: "variant", op: "eq", value: "preview" },
      { column: "capability", op: "eq", value: "previews" },
    ],
    limit: 1,
  });
  return (stamps.rows?.length ?? 0) > 0;
}
