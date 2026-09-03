import { Image } from "expo-image";
import { AppState, Platform } from "react-native";
import type { AppStateStatus } from "react-native";

const MEMORY_COST_BUDGET_BYTES = 64 * 1024 * 1024;

const MEMORY_COUNT_BUDGET = 256;

export function releasesImageMemory(status: AppStateStatus): boolean {
  return status === "background";
}

let configured = false;

export function configurePhotoImageCache(): void {
  if (configured) return;
  configured = true;
  if (Platform.OS === "ios") {
    Image.configureCache({
      maxMemoryCost: MEMORY_COST_BUDGET_BYTES,
      maxMemoryCount: MEMORY_COUNT_BUDGET,
    });
  }
  AppState.addEventListener("memoryWarning", () => {
    void Image.clearMemoryCache();
  });
  AppState.addEventListener("change", (status) => {
    if (releasesImageMemory(status)) void Image.clearMemoryCache();
  });
}
