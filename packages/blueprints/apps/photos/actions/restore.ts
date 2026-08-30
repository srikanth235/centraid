import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** The asset row and its bytes un-soft-delete with metadata intact; album
 *  membership is NOT restored. Restoring a live photo fails as a
 *  precondition. */
export default async function restore({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "media.restore_asset",
    input: { asset_id: String(input.asset_id ?? "") },
  });
}
