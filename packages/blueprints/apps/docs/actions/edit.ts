import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** Refuses trashed documents; media_type LIKE 'text/%' only. */
export default async function edit({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.edit_document",
    input: {
      document_id: String(input.document_id ?? ""),
      body_text: String(input.body_text ?? ""),
      ...(input.title == null ? {} : { title: String(input.title) }),
    },
  });
}
