import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** One shared "Tags" concept scheme across apps; the subject type is the seam. */
export default async function tagHandler({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.tag_item",
    input: {
      subject_type: "core.document",
      subject_id: String(input.document_id ?? ""),
      label: String(input.label ?? ""),
    },
  });
}
