// Remote media (thumbs, previews, videos) is served by the gateway, which in
// manual-URL dev mode expects the same Authorization header `exportAsset` and
// every replica fetch already send. Device `file://` URIs need none. Keeping
// this in one place stops thumbnails from silently 401ing while downloads work.

import type { ImageSource } from 'expo-image';
import type { VideoSource } from 'expo-video';

import { authHeader } from '../../lib/gateway';

function isRemote(uri: string): boolean {
  return uri.startsWith('http:') || uri.startsWith('https:');
}

export function imageSource(uri: string): ImageSource | string {
  return isRemote(uri) ? { uri, headers: authHeader() } : uri;
}

export function videoSource(uri: string): VideoSource {
  return isRemote(uri) ? { uri, headers: authHeader() } : uri;
}
