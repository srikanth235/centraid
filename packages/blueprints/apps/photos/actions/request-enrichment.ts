/**
 * Ask the enricher to run now through enrich.request_enrichment (issue
 * #352 phase 3/4) — the owner's on-demand "Detect faces now", `reason:
 * 'manual'` distinguishing it from the enricher's own passive
 * search-miss/on-view triggers. `entity_id` is optional: omitted, this asks
 * the enricher to sweep the whole photos domain rather than one asset.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }: HandlerArgs) => {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: 'enrich.request_enrichment',
      input: {
        entity_type: String(input.entity_type ?? 'media.media_asset'),
        ...(input.entity_id != null ? { entity_id: String(input.entity_id) } : {}),
        reason: 'manual',
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
