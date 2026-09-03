import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function removeFromAlbum({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "media.remove_from_album",
    input: {
      album_id: String(input.album_id ?? ""),
      asset_id: String(input.asset_id ?? ""),
    },
  });
}
