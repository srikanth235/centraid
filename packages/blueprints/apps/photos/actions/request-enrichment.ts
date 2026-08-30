import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** The capability stays pinned to 'faces' — it is the consent scope (#352). */
export default async function requestEnrichment({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "enrich.request_enrichment",
    input: {
      entity_type: String(input.entity_type ?? "media.asset"),
      ...(input.entity_id == null
        ? {}
        : { entity_id: String(input.entity_id) }),
      reason: "manual",
      capability: "faces",
    },
  });
}
