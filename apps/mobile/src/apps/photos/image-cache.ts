// An app-wide ceiling on expo-image's in-memory bitmap cache (#659 M6).
//
// expo-image ships with no memory budget: `maxMemoryCost` and `maxMemoryCount`
// both default to 0, which the docs spell as "no limit". A long scroll through
// the photo grid therefore keeps every decoded thumbnail alive until the OS
// starts killing the app.
//
// The two platforms give different amounts of rope, and both are used:
//
// - iOS has `Image.configureCache`, an explicit byte/count budget on the
//   SDWebImage memory cache. Verified against the installed expo-image 57
//   (`ios/ImageModule.swift` registers `configureCache`, and its type
//   declaration marks it `@platform ios`). It genuinely does not exist on
//   Android — the Android module (`ExpoImageModule.kt`) registers no such
//   function — so calling it there would throw, hence the platform check.
// - Android's Glide cache is sized by the framework and has no equivalent
//   knob in expo-image 57. The lever that *is* available on both platforms is
//   dropping the cache on demand, so both get an AppState-driven release.
//
// The result is bounded on both platforms, by different mechanisms: a hard
// ceiling on iOS, and a release-on-pressure policy everywhere.

import { Image } from "expo-image";
import { AppState, Platform } from "react-native";
import type { AppStateStatus } from "react-native";

/**
 * ~64 MiB of decoded pixels. A four-column grid on a 3x screen decodes roughly
 * 300x300x4 bytes per cell, so this holds on the order of 180 thumbnails —
 * several screens of scrollback in either direction — while leaving headroom
 * for the lightbox, which decodes at full viewport size.
 */
const MEMORY_COST_BUDGET_BYTES = 64 * 1024 * 1024;

/** A second ceiling so a grid of tiny images cannot hold thousands of entries. */
const MEMORY_COUNT_BUDGET = 256;

/**
 * Backgrounding is the one moment the app can give memory back for free:
 * nothing is on screen, and re-decoding on return costs a frame the user is
 * not watching. `inactive` is excluded — on iOS that is the app switcher and a
 * transient control-centre pull, both of which return straight to the same
 * scroll position.
 */
export function releasesImageMemory(status: AppStateStatus): boolean {
  return status === "background";
}

let configured = false;

/**
 * Idempotent: safe to call from module scope on every reload. The listeners are
 * process-lifetime by design and are never removed — there is no point in the
 * app's life at which an unbounded image cache is wanted again.
 */
export function configurePhotoImageCache(): void {
  if (configured) return;
  configured = true;
  if (Platform.OS === "ios") {
    Image.configureCache({
      maxMemoryCost: MEMORY_COST_BUDGET_BYTES,
      maxMemoryCount: MEMORY_COUNT_BUDGET,
    });
  }
  // iOS-only in React Native (`AppStateModule` on Android never emits it), but
  // registered unconditionally: an event that never fires costs nothing, and a
  // platform branch here would be a lie about intent.
  AppState.addEventListener("memoryWarning", () => {
    void Image.clearMemoryCache();
  });
  AppState.addEventListener("change", (status) => {
    if (releasesImageMemory(status)) void Image.clearMemoryCache();
  });
}
