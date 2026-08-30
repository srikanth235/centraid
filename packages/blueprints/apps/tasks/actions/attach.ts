import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** Bytes arrive either STAGED (#296: streamed to /_vault/blobs, sha claimed
 *  here) or as a small inline data: URI; the vault dedupes them into one
 *  canonical content item. */
export default async function attachHandler({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.attach",
    input: {
      subject_type: "schedule.task",
      subject_id: String(input.subject_id ?? ""),
      ...(input.staged_sha == null
        ? { data_uri: String(input.data_uri ?? "") }
        : { staged_sha: String(input.staged_sha) }),
      ...(input.title == null ? {} : { title: String(input.title) }),
      ...(input.role == null ? {} : { role: String(input.role) }),
    },
  });
}
