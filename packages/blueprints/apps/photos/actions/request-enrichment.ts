/**
 * Ask the enricher to run now through enrich.request_enrichment (issue
 * #352 phase 3/4) — the owner's on-demand "Detect faces now", `reason:
 * 'manual'` distinguishing it from the enricher's own passive
 * search-miss/on-view triggers. `entity_id` is optional: omitted, this asks
 * the recognition recipe to process the whole photos domain rather than one
 * asset. The request remains the explicit consent boundary either way.
 *
 * `capability: 'faces'` is pinned here, not accepted from the caller (the
 * action's `input` schema is `additionalProperties: false`, so it cannot be
 * spoofed). It is the CONSENT SCOPE: this surface asks a face-detection
 * question and receives a face-detection answer, so the queue row it writes
 * must be drainable by a face detector ALONE. Before the column existed the
 * same untagged row was picked up by every enabled enricher, which turned one
 * consent into consent for captioning, screenshot OCR and the rest.
 *
 * The release-managed `faces/faces` recognition recipe drains this row only
 * after a successful, capability-scoped derivation. It never treats the
 * ambient library as consent: a target-less request is the explicit
 * vault-wide grant, and a targeted request authorizes only that asset.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
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
