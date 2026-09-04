import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function createAlbum({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "media.create_album",
    input: {
      title: String(input.title ?? ""),
      // The seat mints the row's id and the origin honours it (#922 G2).
      ...(input.album_id ? { album_id: String(input.album_id) } : {}),
    },
  });
}
