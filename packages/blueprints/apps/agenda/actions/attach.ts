import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/**
 * Pin a file to an event through core.attach. Bytes arrive either staged
 * (#296: streamed to /_vault/blobs, claimed here by sha) or as a small inline
 * data: URI; the vault dedupes them into one canonical content item.
 */
export default async function attachHandler({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.attach",
    input: {
      subject_type: "core.event",
      subject_id: String(input.subject_id ?? ""),
      ...(input.staged_sha == null
        ? { data_uri: String(input.data_uri ?? "") }
        : { staged_sha: String(input.staged_sha) }),
      ...(input.title == null ? {} : { title: String(input.title) }),
      ...(input.role == null ? {} : { role: String(input.role) }),
    },
  });
}
