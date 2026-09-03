import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function restore({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "media.restore_asset",
    input: { asset_id: String(input.asset_id ?? "") },
  });
}
