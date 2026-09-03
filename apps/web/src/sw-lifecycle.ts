import { saveSettingsPatch } from "./web-state.js";

export async function requestPersistentStorage(): Promise<void> {
  try {
    if (!navigator.storage?.persist) return;
    const granted =
      (await navigator.storage.persisted?.()) ||
      (await navigator.storage.persist());
    console.info(
      `[centraid] persistent storage ${granted ? "granted" : "denied"}`
    );
    saveSettingsPatch({ storagePersisted: granted });
  } catch {
    // Intentionally empty.
  }
}

export function purgeTunnelCaches(): void {
  navigator.serviceWorker?.controller?.postMessage({
    type: "centraid:purge-tunnel-cache",
  });
  if ("caches" in globalThis) {
    void caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith("centraid-tunnel-assets-") ||
                key.startsWith("centraid-tunnel-blobs-")
            )
            .map((key) => caches.delete(key))
        )
      )
      .catch(() => undefined);
  }
}

let updateAvailable = false;
const updateListeners = new Set<
  (msg: { available: boolean; version: string }) => void
>();

export function isUpdateAvailable(): boolean {
  return updateAvailable;
}

export function onSwUpdateAvailable(
  listener: (msg: { available: boolean; version: string }) => void
): () => void {
  updateListeners.add(listener);
  if (updateAvailable) listener({ available: true, version: "web" });
  return () => updateListeners.delete(listener);
}

function markUpdateAvailable(): void {
  if (updateAvailable) return;
  updateAvailable = true;
  for (const listener of updateListeners)
    listener({ available: true, version: "web" });
}

export function watchServiceWorkerUpdates(): void {
  if (!("serviceWorker" in navigator)) return;
  let hadController = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) {
      hadController = true; // initial claim on first load — not an update
      return;
    }
    markUpdateAvailable();
  });
}
