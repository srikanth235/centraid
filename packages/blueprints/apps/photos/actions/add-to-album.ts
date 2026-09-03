import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function addToAlbum({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "media.add_to_album",
    input: {
      album_id: String(input.album_id ?? ""),
      asset_id: String(input.asset_id ?? ""),
    },
  });
}
