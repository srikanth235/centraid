/**
 * Fold a duplicate person into a survivor via the ontology primitive
 * `core.merge_party` (#290). People no longer own a soft-merge fork —
 * every FK re-points, the merged party is deleted, and the act is
 * confirm-gated for non-owner callers.
 *
 * Action body keeps the People-facing names (source = folded away,
 * target = survivor) and maps them onto the core command's survivor /
 * merged pair.
 */
export default async function mergePeople({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  try {
    const input = (body ?? {}) as {
      source_party_id?: string;
      target_party_id?: string;
    };
    const outcome = await ctx.vault.invoke({
      command: "core.merge_party",
      input: {
        survivor_party_id: input.target_party_id,
        merged_party_id: input.source_party_id,
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
