import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function namePlace({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "media.name_place",
    input: {
      place_id: String(input.place_id ?? ""),
      name: String(input.name ?? ""),
      ...(input.kind != null && input.kind !== ""
        ? { kind: String(input.kind) }
        : {}),
    },
  });
}
