import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function createFolder({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.create_folder",
    input: {
      name: String(input.name ?? ""),
      // The seat mints the row's id and the origin honours it (#922 G2).
      ...(input.folder_id ? { folder_id: String(input.folder_id) } : {}),
      ...(input.parent_folder_id == null
        ? {}
        : { parent_folder_id: String(input.parent_folder_id) }),
    },
  });
}
