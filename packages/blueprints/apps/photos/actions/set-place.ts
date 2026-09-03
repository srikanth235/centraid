import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function setPlace({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "media.set_asset_place",
    input: {
      asset_id: String(input.asset_id ?? ""),
      ...(input.place_id != null && input.place_id !== ""
        ? { place_id: String(input.place_id) }
        : {}),
    },
  });
}
