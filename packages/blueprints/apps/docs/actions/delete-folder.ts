import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function deleteFolder({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.delete_folder",
    input: {
      folder_id: String(input.folder_id ?? ""),
    },
  });
}
