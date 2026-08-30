import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** Refuses a content id already current, or one outside this document's chain. */
export default async function restoreVersion({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.restore_document_version",
    input: {
      document_id: String(input.document_id ?? ""),
      content_id: String(input.content_id ?? ""),
    },
  });
}
