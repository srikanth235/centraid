/** "Detect faces now" (#352): enrich.request_enrichment; capability stays pinned 'faces' — the consent scope. */
export default async function requestEnrichment({ body, ctx }: HandlerArgs) {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: "enrich.request_enrichment",
      input: {
        entity_type: String(input.entity_type ?? "media.asset"),
        ...(input.entity_id == null
          ? {}
          : { entity_id: String(input.entity_id) }),
        reason: "manual",
        capability: "faces",
      },
      purpose: "dpv:ServiceProvision",
    });
    return { status: 200, body: outcome };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      status: 200,
      body: { status: "denied", reason: e.message, code: e.code },
    };
  }
}
