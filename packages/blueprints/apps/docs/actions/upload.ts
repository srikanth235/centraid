import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/**
 * Bytes arrive staged (#296) or as a small inline data: URI. Re-uploading
 * identical bytes restores the deduped document from trash and renames it.
 */
export default async function upload({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.add_document",
    input: {
      ...(input.staged_sha == null
        ? { data_uri: String(input.data_uri ?? "") }
        : { staged_sha: String(input.staged_sha) }),
      title: String(input.title ?? ""),
      // The seat mints the row's id and the origin honours it (#922 G2).
      ...(input.document_id ? { document_id: String(input.document_id) } : {}),
      ...(input.folder_id == null
        ? {}
        : { folder_id: String(input.folder_id) }),
      ...(input.extracted_text == null
        ? {}
        : { extracted_text: String(input.extracted_text) }),
    },
  });
}
