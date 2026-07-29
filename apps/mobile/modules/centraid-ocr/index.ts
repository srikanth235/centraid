import type { NativeModule } from "expo-modules-core";
import { requireOptionalNativeModule } from "expo-modules-core";

export interface OcrLine {
  text: string;
  confidence: number;
}

export interface OcrResult {
  text: string;
  confidence: number;
  lines: OcrLine[];
  engine: "apple-vision" | "ml-kit";
}

declare class CentraidOcrNativeModule extends NativeModule {
  recognizeText(uri: string): Promise<OcrResult>;
}

const native =
  requireOptionalNativeModule<CentraidOcrNativeModule>("CentraidOcr");

/** Device-native, network-free OCR. Throws honestly when the native build lacks it. */
export async function recognizeText(uri: string): Promise<OcrResult> {
  if (!native)
    throw new Error(
      "On-device OCR is unavailable in this build. Update the Centraid app."
    );
  return native.recognizeText(uri);
}

export function hasOnDeviceOcr(): boolean {
  return Boolean(native);
}
