import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function restoreAlbum({ body, ctx }: HandlerArgs) {
  return runVaultAction(ctx, {
    command: "media.restore_album",
    input: actionInput(body),
  });
}
