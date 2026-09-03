#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createFingerprintAsync, SourceSkips } from "@expo/fingerprint";

const projectRoot = path.resolve(import.meta.dirname, "..");

export const NATIVE_FINGERPRINT_IGNORE_PATHS = [
  "native-fingerprints.json",
  "ios/Centraid.xcodeproj/project.xcworkspace/**/*",
  "android/.kotlin/**/*",
  "modules/centraid-tunnel/ios/Iroh.xcframework/**/*",
  "modules/centraid-tunnel/ios/IrohLib.swift",
  "modules/centraid-tunnel/ios/.iroh-version",
];

export const NATIVE_FINGERPRINT_SOURCE_SKIPS =
  SourceSkips.PackageJsonScriptsAll;

export function nativeFingerprintOptions(platform) {
  if (platform !== "ios" && platform !== "android") {
    throw new Error(`unsupported native fingerprint platform: ${platform}`);
  }
  return {
    platforms: [platform],
    ignorePaths: NATIVE_FINGERPRINT_IGNORE_PATHS,
    sourceSkips: NATIVE_FINGERPRINT_SOURCE_SKIPS,
  };
}

export async function fingerprintForPlatform(platform) {
  const fingerprint = await createFingerprintAsync(
    projectRoot,
    nativeFingerprintOptions(platform)
  );
  if (!fingerprint.hash || fingerprint.sources.length === 0) {
    throw new Error(
      `empty ${platform} fingerprint — refusing to emit a constant key`
    );
  }
  return fingerprint.hash;
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const platform = process.argv[2];
  if (platform !== "ios" && platform !== "android") {
    process.stderr.write("usage: native-fingerprint.mjs <ios|android>\n");
    process.exit(2);
  }
  try {
    process.stdout.write(await fingerprintForPlatform(platform));
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exit(1);
  }
}
