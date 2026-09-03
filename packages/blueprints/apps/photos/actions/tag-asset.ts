import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function tagAsset({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.tag_item",
    input: {
      subject_type: "media.asset",
      subject_id: String(input.asset_id ?? ""),
      label: String(input.label ?? ""),
    },
  });
}
