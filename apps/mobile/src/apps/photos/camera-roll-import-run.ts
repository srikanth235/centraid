// Network half of the first-run camera-roll import (#724): the `attempt` for camera-roll-import.ts's pure logic.

import { File } from "expo-file-system";

import { authHeader } from "../../lib/gateway";
import { bytesToBase64 } from "../../lib/upload/bytes";
import {
  cleanupDeviceDerivatives,
  contributeDeviceDerivatives,
  contributeDeviceHashes,
  gatewayCanDecode,
  generateDeviceDerivatives,
} from "../../lib/upload/derivatives-native";
import type { SourceSize } from "../../lib/upload/derivatives-native";
import { createNativeDigest } from "../../lib/upload/native-digest";
import { runCameraRollImport } from "./camera-roll-import";
import type {
  ImportCandidate,
  ImportOutcome,
  ImportProgress,
} from "./camera-roll-import";
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

export function sha256OfBytes(bytes: Uint8Array): string {
  const digest = createNativeDigest();
  digest.update(bytes);
  return digest.digestHex();
}

/**
 * THE PHONE'S DISPLAY RUNGS FOR AN ORIGINAL THE GATEWAY CANNOT DECODE (#1011).
 *
 * The gateway's preview codec ships without an HEVC decoder, so the HEIC an
 * iPhone writes declines there and earns the durable `preview-codec@1`
 * "unsupported" stamp — on a real phone that would be most of the library,
 * never recognised. iOS decodes it natively, so the phone renders the ladder's
 * own edges here and contributes them through the variant door.
 *
 * ORDER IS THE CONTRACT: `variant_of` must "identify staged or claimed
 * content", so this runs AFTER the original is staged and BEFORE the publish
 * that claims it — the rungs are then on the `core_content_derivative` row the
 * moment recognition can first see the asset, and the ingress contributor never
 * gets to stamp a decline over them.
 *
 * NEVER FATAL: a rung is an accelerator, not custody. A failure here leaves the
 * item exactly as backfillable as it was, so the import still publishes.
 *
 * BUT NEVER SILENT (logs.md). A silent accelerator is still an accelerator; a
 * silent FAILURE of the only path that can preview HEIC is a bug nobody can
 * see — the item just sits at `preview-codec@1` unsupported with no line
 * anywhere saying why. Both swallowed failures name themselves on the console.
 */
async function contributeDeviceRungs(
  gatewayBase: string,
  parentSha: string,
  filename: string,
  localUri: string,
  sourceSize?: SourceSize
): Promise<void> {
  let set;
  try {
    set = await generateDeviceDerivatives(localUri, "image/heic", sourceSize);
  } catch (error) {
    console.warn(
      `[centraid] import: device rungs skipped for ${filename} — could not render on device: ${reasonOf(error)}`
    );
    return;
  }
  try {
    // Binary rungs first: the tile a member sees is the thumb, and the inline
    // hashes below only decorate it.
    await contributeDeviceDerivatives(gatewayBase, parentSha, set.binary);
    await contributeDeviceHashes(gatewayBase, parentSha, {
      phash: set.phash,
      thumbhash: set.thumbhash,
    });
    console.log(
      `[centraid] import: device rungs landed for ${filename} — ${[
        ...set.binary.map((rung) => rung.variant),
        "phash",
        "thumbhash",
      ].join(", ")}`
    );
  } catch (error) {
    // Left backfillable; the sweep is the backstop it always was.
    console.warn(
      `[centraid] import: device rungs skipped for ${filename} — contribution failed: ${reasonOf(error)}`
    );
  } finally {
    cleanupDeviceDerivatives(set.binary);
  }
}

/** The contribution helpers name the HTTP status in their message, so the
 *  reason a reader needs is already in there. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One file through the SAME staged-import door as a dropped Takeout zip;
 *  true = NEW, not a dedupe skip. */
async function stageAndPublishOne(
  gatewayBase: string,
  filename: string,
  bytes: Uint8Array,
  options: {
    captureGroupId?: string;
    /** Present only for a still whose type the gateway cannot decode. */
    rungSource?: { localUri: string; sourceSize?: SourceSize };
  } = {}
): Promise<{ created: boolean }> {
  const captureGroupId = options.captureGroupId;
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
  if (options.rungSource) {
    await contributeDeviceRungs(
      gatewayBase,
      sha256OfBytes(bytes),
      filename,
      options.rungSource.localUri,
      options.rungSource.sourceSize
    );
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
    {
      ...(captureGroupId ? { captureGroupId } : {}),
      // Only a still, and only one the gateway would decline: a JPEG already
      // gets its rungs from the ingress contributor, and a video's preview is a
      // non-goal on both sides of the wire.
      ...(candidate.kind === "photo" && !gatewayCanDecode(candidate.filename)
        ? {
            rungSource: {
              localUri: original.uri,
              ...(await shapeOf(original.asset)),
            },
          }
        : {}),
    }
  );
  if (companion) {
    const companionFile = new File(companion);
    await stageAndPublishOne(
      gatewayBase,
      companionFile.name,
      await companionFile.bytes(),
      captureGroupId ? { captureGroupId } : {}
    );
  }
  return still.created ? "imported" : "skipped";
}

/** Dimensions let the rungs fit the LONG edge, as the ladder does; a device
 *  that will not report them still gets width-fitted rungs. */
async function shapeOf(
  asset: Awaited<ReturnType<typeof openDeviceOriginal>>["asset"]
): Promise<{ sourceSize?: SourceSize }> {
  try {
    const shape = await asset.getShape();
    return shape
      ? { sourceSize: { width: shape.width, height: shape.height } }
      : {};
  } catch {
    return {};
  }
}

/**
 * THE BATCH, WITH THE SEAT NUDGED ONCE AT THE END (#1011 M2).
 *
 * The import publishes through the gateway's staged-import route, so the rows
 * it commits are rows this phone's own seat knows nothing about: before this,
 * the owner's freshly imported photographs appeared in their library only when
 * the next app-state foreground happened to pull the log — two minutes of
 * nothing, on the device.
 *
 * ONE nudge per batch, not per photograph, and none at all when the batch
 * published nothing (every candidate failed, or every one was a dedupe skip):
 * there is no new row to come and fetch. Not a poll — the ordinary catch-up
 * paths are untouched.
 */
export async function runImportBatchWithNudge(
  gatewayBase: string,
  candidates: readonly ImportCandidate[],
  progress: ImportProgress,
  deps: {
    nudgeSeat: () => void | Promise<unknown>;
    onProgress?: (progress: ImportProgress) => void;
    /** Injected by the tests; the real attempt otherwise. */
    attempt?: (candidate: ImportCandidate) => Promise<ImportOutcome>;
  }
): Promise<ImportProgress> {
  const attempt =
    deps.attempt ??
    ((candidate: ImportCandidate) =>
      attemptImportCandidate(gatewayBase, candidate));
  const result = await runCameraRollImport(candidates, progress, {
    attempt,
    ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
  });
  if (result.imported > progress.imported) await deps.nudgeSeat();
  return result;
}
