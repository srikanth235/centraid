// SENDING A COPY — the one path a photograph takes off this device (#816).
//
// Handing the share sheet `resolveLocalOriginal(asset)` and being done sends
// the original file, whose EXIF still carries the metre-accurate fix the camera
// wrote — and nothing in the UI would say so: a member choosing to send a
// picture of their kitchen would be sending their address with no way to know
// it.
//
// So a share is two decisions and one guarantee:
//
//   1. WHAT THE MEMBER CHOSE. `share-place.ts` (a blueprint, so the web gets
//      the same three precisions when it grows a share) owns the choice and
//      its default, which is `none`.
//   2. WHAT THE WORDS ARE. Only the `name` precision sends any, and they come
//      from `sharePlaceMessage`, which is `placePhrase` with `context:
//      "shared"` — the rung that would say "3.4 km NE of Home" is skipped
//      there, so a Home-relative phrase cannot leave from here.
//   3. WHAT THE BYTES ARE. Anything below `exact` leaves through
//      `stripJpegLocation`, so the removal is a fact about the file the
//      receiver opens, not about the screen the sender looked at.
//
// WHY THIS IS ITS OWN MODULE. So that "a photograph leaves the device" is one
// function with one test, rather than a `Share.share` call sitting in a 900
// line viewer where the next feature can quietly add a second one.
// `share-place-call-sites.test.ts` holds that line: no other file under Photos
// may call the OS share APIs.
//
// WHAT IS NOT A SHARE. Saving to the camera roll (`MediaLibrary.Asset.create`,
// still in the viewer) writes to the member's OWN device library, where the
// original with its own metadata already is. Scrubbing there would remove a
// fix from a photograph the member is keeping, which is a different product
// decision — and a lossy one — so this module does not reach it.

import { File, Paths } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as Sharing from "expo-sharing";
import { Share } from "react-native";

import {
  SHARE_PLACE_NOT_REMOVABLE,
  sharePlaceMessage,
  sharePlaceStripsLocation,
} from "@centraid/blueprints/apps/photos/share-place";
import type {
  SharePlaceInput,
  SharePlacePrecision,
} from "@centraid/blueprints/apps/photos/share-place";

import { isJpeg, stripJpegLocation } from "./exif-location-strip";

/**
 * The location is in the bytes and this device cannot get it out.
 *
 * Its own class so the viewer can tell it apart from a failed download and say
 * the sentence the member needs — which names the way through, rather than
 * reading as a bug.
 */
export class LocationNotRemovableError extends Error {
  constructor() {
    super(SHARE_PLACE_NOT_REMOVABLE);
    this.name = "LocationNotRemovableError";
  }
}

/** What the OS is handed. `message` exists only at the `name` precision. */
export interface SharePayload {
  uri: string;
  message?: string;
}

/** The media kinds a timeline row can be — `PhotoAsset["kind"]`, restated so
 *  this module does not depend on the timeline to know what it is sending. */
export type ShareKind = "photo" | "video" | "audio" | "scan";

/** Kinds a still-image re-encode is a sane fallback for. A video would have to
 *  be transcoded, and audio has no frame to render. */
const RE_ENCODABLE: readonly ShareKind[] = ["photo", "scan"];

export interface ShareRequest {
  /** The full-quality bytes, already resolved to a file this device can read. */
  uri: string;
  kind: ShareKind;
  /** What the receiver should see the file called. */
  filename?: string | null;
  precision: SharePlacePrecision;
  place: SharePlaceInput;
}

/** Where scrubbed copies are staged — a folder of its own, so a copy can keep
 *  the original's filename without overwriting a download sitting in the cache
 *  under the same name. */
const SHARE_FOLDER = "shared-copies";

/** The same 0.92 the editor commits at, for the re-encode path below. */
const RE_ENCODE_QUALITY = 0.92;

/** The name the receiver sees, forced to `.jpg` when the copy was re-encoded. */
function outgoingName(
  filename: string | null | undefined,
  jpeg: boolean
): string {
  const base = (filename ?? "").split("/").pop() ?? "";
  const trimmed = base.trim() === "" ? "photograph.jpg" : base.trim();
  if (!jpeg) return trimmed;
  return /\.jpe?g$/iu.test(trimmed)
    ? trimmed
    : `${trimmed.replace(/\.[^.]+$/u, "")}.jpg`;
}

/**
 * The photograph as JPEG bytes, re-encoding once if it arrived in a container
 * this device cannot walk.
 *
 * HEIC is the iPhone default and PNG comes off screenshots and edits; neither
 * is a JPEG, and neither has a segment walker here. Re-encoding through
 * `expo-image-manipulator` produces a frame with no metadata at all — but the
 * claim does not rest on that, because the result goes through the walker
 * anyway. A video is never re-encoded: transcoding a member's video to strip a
 * tag would be a worse thing to do to it than refusing.
 */
async function jpegBytes(request: ShareRequest): Promise<Uint8Array> {
  const original = await new File(request.uri).bytes();
  if (isJpeg(original)) return original;
  if (!RE_ENCODABLE.includes(request.kind))
    throw new LocationNotRemovableError();
  const rendered = await ImageManipulator.manipulate(request.uri).renderAsync();
  const saved = await rendered.saveAsync({
    compress: RE_ENCODE_QUALITY,
    format: SaveFormat.JPEG,
  });
  const bytes = await new File(saved.uri).bytes();
  if (!isJpeg(bytes)) throw new LocationNotRemovableError();
  return bytes;
}

/**
 * A copy of the photograph with its location gone, staged in the cache.
 *
 * Throws rather than degrading: the one outcome this module may not produce is
 * a share the member believes carries no place and does.
 */
async function scrubbedCopy(request: ShareRequest): Promise<string> {
  const stripped = stripJpegLocation(await jpegBytes(request));
  if (stripped === null) throw new LocationNotRemovableError();
  const file = new File(
    Paths.cache,
    SHARE_FOLDER,
    outgoingName(request.filename, true)
  );
  // The staged copy outlives the share by design — the OS reads the file after
  // this promise resolves — so a second share of the same photograph overwrites
  // rather than failing, exactly as the Insights CSV export does.
  file.create({ intermediates: true, overwrite: true });
  file.write(stripped.bytes);
  return file.uri;
}

/**
 * Hand the payload to whichever sheet can carry it.
 *
 * `expo-sharing` takes a file and nothing else, so a phrase can only travel
 * through React Native's own `Share`. Both are here rather than in the viewer
 * so there is one place where bytes leave.
 */
async function hand(payload: SharePayload): Promise<void> {
  if (payload.message === undefined && (await Sharing.isAvailableAsync())) {
    await Sharing.shareAsync(payload.uri);
    return;
  }
  await Share.share(
    payload.message === undefined
      ? { url: payload.uri }
      : { message: payload.message, url: payload.uri }
  );
}

/**
 * Send a copy at the precision the member chose, and answer what left.
 *
 * The return value is the payload the OS received, so a caller (and a test)
 * can state what was disclosed rather than trusting that it was the right
 * thing.
 */
export async function shareOriginal(
  request: ShareRequest
): Promise<SharePayload> {
  const uri = sharePlaceStripsLocation(request.precision)
    ? await scrubbedCopy(request)
    : request.uri;
  const message = sharePlaceMessage(request.precision, request.place);
  const payload: SharePayload =
    message === undefined ? { uri } : { message, uri };
  await hand(payload);
  return payload;
}
