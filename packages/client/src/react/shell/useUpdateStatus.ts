import { useEffect, useState } from 'react';

export interface UpdateStatus {
  available: boolean;
  version: string;
  /** False while a packaged update is still downloading (#501). */
  readyToInstall?: boolean;
}

/**
 * The main process's dist watcher (main/update-watcher.ts) notices a newer
 * build landing on disk while the app runs. This hook snapshots that status
 * on mount (in case the broadcast fired before the shell mounted) and
 * subscribes to the push; non-null means "show the Relaunch to update pill".
 * Bridge methods are optional-chained — test harnesses mock a partial API.
 */
export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    let alive = true;
    void window.CentraidApi.getUpdateStatus?.()
      .then((s) => {
        if (alive && s.available) setStatus(s);
      })
      .catch(() => {
        // Bridge unavailable (tests, harness) — no pill.
      });
    const off = window.CentraidApi.onUpdateAvailable?.((s) => {
      if (s.available) setStatus(s);
    });
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return status;
}

/** Sidebar pill title — download still in flight vs ready to install. */
export function updatePillTitle(status: UpdateStatus): string {
  if (status.readyToInstall === false) return 'Update downloading…';
  return status.readyToInstall === true ? 'Restart to install' : 'Relaunch to update';
}

/** Ask main to restart into the new build. Fire-and-forget: the app exits. */
export function relaunchToUpdate(): void {
  void window.CentraidApi.relaunchToUpdate?.();
}
