// The network half of the first-run camera-roll import (issue #724 A2). The
// pure batching/resume logic lives in `camera-roll-import.ts` — this file is
// the one `attempt` that logic is handed: open one device original, stage it
// on the vault's existing file-drop route, publish the draft it creates, and
// say which of "imported" / "skipped" / "failed" happened. Not unit-tested on
// its own — it is a thin adapter over native file I/O and `fetch`, the same
// division `photo-edit-save.ts` and `photos-backup.ts` already draw between a
// provable model and the I/O that drives it.

import { File } from "expo-file-system";

import { authHeader } from "../../lib/gateway";
import { bytesToBase64 } from "../../lib/upload/bytes";
import type { ImportCandidate, ImportOutcome } from "./camera-roll-import";
import { liveVideoUri, openDeviceOriginal } from "./device-media";

interface StageResponse {
  batchId: string;
  staged: { create: number; update: number; skip: number };
  unrouted: string[];
}

interface PublishResponse {
  batchId: string;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

/** One `filename` + full bytes through the SAME staged-import door a dropped
 *  Takeout zip uses (`import-routes.ts`), then an explicit publish — draft,
 *  then landed, exactly as the desktop's own review surface does it. Returns
 *  whether this file's bytes were genuinely NEW (a create) or already in the
 *  vault by content (a dedupe skip/update) — the caller folds that into the
 *  candidate's own outcome. */
async function stageAndPublishOne(
  gatewayBase: string,
  filename: string,
  bytes: Uint8Array,
  captureGroupId?: string
): Promise<{ created: boolean }> {
  const staged = await fetch(`${gatewayBase}/centraid/_vault/imports`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader() },
    body: JSON.stringify({
      filename,
      base64: bytesToBase64(bytes),
      ...(captureGroupId ? { captureGroupId } : {}),
    }),
  });
  if (!staged.ok) {
    throw new Error(`stage ${filename} failed (${staged.status})`);
  }
  const stagedBody = (await staged.json()) as StageResponse;
  if (stagedBody.unrouted.length > 0) {
    throw new Error(`${filename} was not recognised as a photograph or video`);
  }
  const published = await fetch(
    `${gatewayBase}/centraid/_vault/imports/${stagedBody.batchId}/publish`,
    { method: "POST", headers: authHeader() }
  );
  if (!published.ok) {
    throw new Error(`publish of ${filename} failed (${published.status})`);
  }
  const publishedBody = (await published.json()) as PublishResponse;
  if (publishedBody.failed > 0) {
    throw new Error(`${filename} failed to publish`);
  }
  return { created: publishedBody.created > 0 };
}

/**
 * The `attempt` function `runCameraRollImport` drives: open this candidate's
 * device original, stage and publish it, and — for a still that IS a Live
 * Photo — stage and publish its paired video under the SAME `live:<localId>`
 * capture group, exactly the convention `photos-backup.ts`'s own sweep uses
 * (`media_asset.capture_group_id`, `commands/media.ts`). One extra
 * native call (`liveVideoUri`) per photograph actually being imported, never
 * a bulk pre-scan of the roll — see this module's sibling header for why.
 */
export async function attemptImportCandidate(
  gatewayBase: string,
  candidate: ImportCandidate
): Promise<ImportOutcome> {
  const original = await openDeviceOriginal(candidate.localId);
  const bytes = await new File(original.uri).bytes();
  const companion =
    candidate.kind === "photo" ? await liveVideoUri(original.asset) : null;
  const captureGroupId = companion ? `live:${candidate.localId}` : undefined;
  const still = await stageAndPublishOne(
    gatewayBase,
    candidate.filename,
    bytes,
    captureGroupId
  );
  if (companion) {
    const companionFile = new File(companion);
    await stageAndPublishOne(
      gatewayBase,
      companionFile.name,
      await companionFile.bytes(),
      captureGroupId
    );
  }
  return still.created ? "imported" : "skipped";
}
