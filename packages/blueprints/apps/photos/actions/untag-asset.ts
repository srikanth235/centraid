import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** Removes by tag_id — the specific edge, not the label. The lightbox's tag
 *  chip already has it from the asset's own `tags` join. */
export default async function untagAsset({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.untag_item",
    input: { tag_id: String(input.tag_id ?? "") },
  });
}
