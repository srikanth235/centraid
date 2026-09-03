import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function deleteAlbum({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "media.delete_album",
    input: { album_id: String(input.album_id ?? "") },
  });
}
