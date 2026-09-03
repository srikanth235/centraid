import { useEffect, useState } from "react";

export interface UpdateStatus {
  available: boolean;
  version: string;
  readyToInstall?: boolean;
}

export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    let alive = true;
    void window.CentraidApi.getUpdateStatus?.()
      .then((s) => {
        if (alive && s.available) setStatus(s);
      })
      .catch(() => {});
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

export function updatePillTitle(status: UpdateStatus): string {
  if (status.readyToInstall === false) return "Update downloading…";
  return status.readyToInstall === true
    ? "Restart to install"
    : "Relaunch to update";
}

export function relaunchToUpdate(): void {
  void window.CentraidApi.relaunchToUpdate?.();
}
