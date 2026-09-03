import type { ImageProps } from "expo-image";

const DEVICE_MEDIA_SCHEMES = [
  "ph://",
  "content://",
  "file://",
  "assets-library://",
];

export type GridImageProps = Required<
  Pick<
    ImageProps,
    | "allowDownscaling"
    | "cachePolicy"
    | "contentFit"
    | "decodeFormat"
    | "priority"
  >
>;

export function isDeviceMediaUri(uri: string): boolean {
  return DEVICE_MEDIA_SCHEMES.some((scheme) => uri.startsWith(scheme));
}

export function gridImageProps(uri: string): GridImageProps {
  return {
    allowDownscaling: true,
    cachePolicy: isDeviceMediaUri(uri) ? "memory" : "memory-disk",
    contentFit: "cover",
    decodeFormat: "rgb",
    priority: "low",
  };
}
