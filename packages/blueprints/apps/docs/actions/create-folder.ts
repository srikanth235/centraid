import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function createFolder({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.create_folder",
    input: {
      name: String(input.name ?? ""),
      ...(input.parent_folder_id == null
        ? {}
        : { parent_folder_id: String(input.parent_folder_id) }),
    },
  });
}
