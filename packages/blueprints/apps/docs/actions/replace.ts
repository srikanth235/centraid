import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** Bytes arrive staged (#296) or as a small inline data: URI. */
export default async function replace({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.replace_document_content",
    input: {
      document_id: String(input.document_id ?? ""),
      ...(input.staged_sha == null
        ? { data_uri: String(input.data_uri ?? "") }
        : { staged_sha: String(input.staged_sha) }),
      ...(input.title == null ? {} : { title: String(input.title) }),
    },
  });
}
