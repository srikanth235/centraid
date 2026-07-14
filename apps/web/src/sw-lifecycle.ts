import { saveSettingsPatch } from './web-state.js';

// iOS can evict an origin's storage after ~7 idle days, which would wipe the
// iroh device key and force a re-pair. Requesting persistence after a
// successful pairing marks the origin as durable. Best-effort: the browser may
// refuse, and there is nothing to do about it beyond recording the outcome.
export async function requestPersistentStorage(): Promise<void> {
  try {
    if (!navigator.storage?.persist) return;
    const granted = (await navigator.storage.persisted?.()) || (await navigator.storage.persist());
    console.info(`[centraid] persistent storage ${granted ? 'granted' : 'denied'}`);
    saveSettingsPatch({ storagePersisted: granted });
  } catch {
    /* persistence is advisory only */
  }
}

export function purgeTunnelCaches(): void {
  navigator.serviceWorker?.controller?.postMessage({ type: 'centraid:purge-tunnel-cache' });
}

// A service worker update: the shell's SW calls skipWaiting()+clients.claim(),
// so a new worker takes control mid-session (controllerchange). Rather than
// reload out from under the user, surface the existing "Relaunch to update"
// affordance. The very first controllerchange after a cold load is the initial
// claim, not an update, so it is ignored.
let updateAvailable = false;
const updateListeners = new Set<(msg: { available: boolean; version: string }) => void>();

export function isUpdateAvailable(): boolean {
  return updateAvailable;
}

export function onSwUpdateAvailable(
  callback: (msg: { available: boolean; version: string }) => void,
): () => void {
  updateListeners.add(callback);
  if (updateAvailable) callback({ available: true, version: 'web' });
  return () => updateListeners.delete(callback);
}

function markUpdateAvailable(): void {
  if (updateAvailable) return;
  updateAvailable = true;
  for (const listener of updateListeners) listener({ available: true, version: 'web' });
}

export function watchServiceWorkerUpdates(): void {
  if (!('serviceWorker' in navigator)) return;
  let hadController = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true; // initial claim on first load — not an update
      return;
    }
    markUpdateAvailable();
  });
}
