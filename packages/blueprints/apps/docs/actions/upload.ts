import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function upload({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.add_document",
    input: {
      ...(input.staged_sha == null
        ? { data_uri: String(input.data_uri ?? "") }
        : { staged_sha: String(input.staged_sha) }),
      title: String(input.title ?? ""),
      ...(input.folder_id == null
        ? {}
        : { folder_id: String(input.folder_id) }),
      ...(input.extracted_text == null
        ? {}
        : { extracted_text: String(input.extracted_text) }),
    },
  });
}
