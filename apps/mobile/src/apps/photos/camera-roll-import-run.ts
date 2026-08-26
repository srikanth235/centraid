// Network half of the first-run camera-roll import (#724): the `attempt` for camera-roll-import.ts's pure logic.

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

/** One file through the SAME staged-import door as a dropped Takeout zip;
 *  true = NEW, not a dedupe skip. */
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

/** Stage+publish the device original; a Live Photo also publishes its paired
 *  video under `live:<localId>` (`photos-backup.ts`). Never a bulk pre-scan. */
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
