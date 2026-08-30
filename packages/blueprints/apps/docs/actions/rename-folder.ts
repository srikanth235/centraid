import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function renameFolder({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.rename_folder",
    input: {
      folder_id: String(input.folder_id ?? ""),
      name: String(input.name ?? ""),
    },
  });
}
