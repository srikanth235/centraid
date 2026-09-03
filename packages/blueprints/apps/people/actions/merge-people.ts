import { runVaultAction } from "../../_shared/action-kit.ts";

export default async function mergePeople({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  const input = (body ?? {}) as {
    source_party_id?: string;
    target_party_id?: string;
  };
  return runVaultAction(ctx, {
    command: "core.merge_party",
    input: {
      survivor_party_id: input.target_party_id,
      merged_party_id: input.source_party_id,
    },
  });
}
