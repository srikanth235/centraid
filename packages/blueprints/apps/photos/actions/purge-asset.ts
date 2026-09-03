import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function purgeAsset({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "media.purge_asset",
    input: { asset_id: String(input.asset_id ?? "") },
  });
}
