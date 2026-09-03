import type { ImageSource } from "expo-image";
import type { VideoSource } from "expo-video";

import { authHeader } from "../../lib/gateway";

function isRemote(uri: string): boolean {
  return uri.startsWith("http:") || uri.startsWith("https:");
}

export function imageSource(uri: string): ImageSource | string {
  return isRemote(uri) ? { uri, headers: authHeader() } : uri;
}

export function videoSource(uri: string): VideoSource {
  return isRemote(uri) ? { uri, headers: authHeader() } : uri;
}
