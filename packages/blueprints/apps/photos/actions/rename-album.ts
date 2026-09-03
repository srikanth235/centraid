import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function renameAlbum({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "media.rename_album",
    input: {
      album_id: String(input.album_id ?? ""),
      title: String(input.title ?? ""),
    },
  });
}
