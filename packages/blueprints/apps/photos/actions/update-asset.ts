import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function updateAsset({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "media.update_asset",
    input: {
      asset_id: String(input.asset_id ?? ""),
      ...(input.captured_at == null
        ? {}
        : { captured_at: String(input.captured_at) }),
      ...(input.title == null ? {} : { title: String(input.title) }),
      ...(input.favorite == null ? {} : { favorite: Number(input.favorite) }),
      ...(input.archived == null ? {} : { archived: Number(input.archived) }),
    },
  });
}
