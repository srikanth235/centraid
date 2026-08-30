import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function createAlbum({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "media.create_album",
    input: { title: String(input.title ?? "") },
  });
}
