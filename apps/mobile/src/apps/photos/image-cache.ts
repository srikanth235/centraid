// App-wide ceiling on expo-image's in-memory bitmap cache (#659).
//
// expo-image defaults `maxMemoryCost`/`maxMemoryCount` to 0 ("no limit").
//
// - iOS: `Image.configureCache` is `@platform ios` and does not exist on
//   Android (`ExpoImageModule.kt` registers no such function) — calling it
//   there throws, hence the platform check.
// - Android's Glide cache has no equivalent knob in expo-image 57. Both
//   platforms drop the cache on demand via AppState.

import { Image } from "expo-image";
import { AppState, Platform } from "react-native";
import type { AppStateStatus } from "react-native";

/**
 * ~64 MiB of decoded pixels. A four-column grid on a 3x screen decodes roughly
 * 300x300x4 bytes per cell — on the order of 180 thumbnails — while leaving
 * headroom for the lightbox at full viewport size.
 */
const MEMORY_COST_BUDGET_BYTES = 64 * 1024 * 1024;

/** So a grid of tiny images cannot hold thousands of entries. */
const MEMORY_COUNT_BUDGET = 256;

/**
 * Backgrounding is the one moment the app can give memory back for free.
 * `inactive` is excluded — on iOS that is the app switcher and a transient
 * control-centre pull, both of which return to the same scroll position.
 */
export function releasesImageMemory(status: AppStateStatus): boolean {
  return status === "background";
}

let configured = false;

/**
 * Idempotent. Listeners are process-lifetime and never removed — there is no
 * point at which an unbounded image cache is wanted again.
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
  // iOS-only (`AppStateModule` on Android never emits it), but registered
  // unconditionally: an event that never fires costs nothing, and a platform
  // branch here would be a lie about intent.
  AppState.addEventListener("memoryWarning", () => {
    void Image.clearMemoryCache();
  });
  AppState.addEventListener("change", (status) => {
    if (releasesImageMemory(status)) void Image.clearMemoryCache();
  });
}
