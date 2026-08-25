// SENDING A COPY — the one path a photograph takes off this device (#816).
// Below `exact` the bytes leave through `stripJpegLocation`. No other file under
// Photos may call the OS share APIs (`share-place-call-sites.test.ts`); saving to
// the camera roll is not a share.

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

export class LocationNotRemovableError extends Error {
  constructor() {
    super(SHARE_PLACE_NOT_REMOVABLE);
    this.name = "LocationNotRemovableError";
  }
}

export interface SharePayload {
  uri: string;
  message?: string;
}

export type ShareKind = "photo" | "video" | "audio" | "scan";

const RE_ENCODABLE: readonly ShareKind[] = ["photo", "scan"];

export interface ShareRequest {
  uri: string;
  kind: ShareKind;
  filename?: string | null;
  precision: SharePlacePrecision;
  place: SharePlaceInput;
}

const SHARE_FOLDER = "shared-copies";

const RE_ENCODE_QUALITY = 0.92;

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

/** HEIC and PNG have no walker here, so re-encode. A video is never re-encoded —
 *  refuse instead of transcoding it. */
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

/** Throws rather than degrading: never a share that hides a place it carries. */
async function scrubbedCopy(request: ShareRequest): Promise<string> {
  const stripped = stripJpegLocation(await jpegBytes(request));
  if (stripped === null) throw new LocationNotRemovableError();
  const file = new File(
    Paths.cache,
    SHARE_FOLDER,
    outgoingName(request.filename, true)
  );
  file.create({ intermediates: true, overwrite: true });
  file.write(stripped.bytes);
  return file.uri;
}

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
