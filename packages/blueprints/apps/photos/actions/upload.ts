import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function upload({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "media.add_asset",
    input: {
      ...(input.staged_sha == null
        ? { data_uri: String(input.data_uri ?? "") }
        : { staged_sha: String(input.staged_sha) }),
      ...(input.kind == null ? {} : { kind: String(input.kind) }),
      ...(input.captured_at == null
        ? {}
        : { captured_at: String(input.captured_at) }),
      ...(input.tz_offset_min == null
        ? {}
        : { tz_offset_min: Number(input.tz_offset_min) }),
      ...(input.capture_group_id == null
        ? {}
        : { capture_group_id: String(input.capture_group_id) }),
      ...(input.source_asset_id == null
        ? {}
        : { source_asset_id: String(input.source_asset_id) }),
      ...(input.title == null ? {} : { title: String(input.title) }),
      ...(input.width == null ? {} : { width: Number(input.width) }),
      ...(input.height == null ? {} : { height: Number(input.height) }),
      ...(input.duration_s == null
        ? {}
        : { duration_s: Number(input.duration_s) }),
      ...(input.phash == null ? {} : { phash: String(input.phash) }),
      ...(input.thumbhash == null
        ? {}
        : { thumbhash: String(input.thumbhash) }),
    },
  });
}
