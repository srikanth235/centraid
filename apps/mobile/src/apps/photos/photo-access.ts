export type PhotoAccessState =
  | "granted"
  | "limited"
  | "denied"
  | "undetermined";

export interface PhotoAccessPermission {
  status: "granted" | "denied" | "undetermined";
  accessPrivileges?: "all" | "limited" | "none";
  canAskAgain: boolean;
}

export function photoAccessState(
  permission: PhotoAccessPermission
): PhotoAccessState {
  if (permission.accessPrivileges === "limited") return "limited";
  if (permission.status === "granted") return "granted";
  return permission.status === "denied" ? "denied" : "undetermined";
}

export function photoAccessTakesOverTimeline({
  state,
  deviceReadableCount,
  vaultReadableCount = 0,
  loading,
}: {
  state: PhotoAccessState | null;
  deviceReadableCount: number;
  vaultReadableCount?: number;
  loading: boolean;
}): boolean {
  if (state === null || state === "granted") return false;
  if (loading) return false;
  if (vaultReadableCount > 0) return false;
  if (state === "limited") return deviceReadableCount === 0;
  return true;
}

export interface PhotoAccessRow {
  label: string;
  sub: string;
  meta: string;
  net?: true;
}

export type PhotoAccessAction = "ask" | "settings";

export interface PhotoAccessControl {
  action: PhotoAccessAction;
  label: string;
}

export interface PhotoAccessCopy {
  headline: string;
  lede: string;
  primary: PhotoAccessControl | null;
  secondary: PhotoAccessControl | null;
  rows: PhotoAccessRow[];
}

const RESTORED_ROW: PhotoAccessRow = {
  label: "What happens if the grant returns",
  sub: "the timeline is exactly as you left it, including your tile size",
  meta: "restored",
};

const NOTHING_ROW: PhotoAccessRow = {
  label: "What Photos can see",
  sub: "nothing — not dates, not thumbnails",
  meta: "none",
  net: true,
};

const OPEN_SETTINGS: PhotoAccessControl = {
  action: "settings",
  label: "Open Settings",
};

export function photoAccessCopy(
  state: PhotoAccessState,
  {
    canAskAgain,
    readableCount,
  }: { canAskAgain: boolean; readableCount: number | null }
): PhotoAccessCopy {
  if (state === "granted") {
    return {
      headline: "Photos can reach your camera roll",
      lede: "Photos reads the photographs on this device to show them back to you. It reads them where they are and moves nothing.",
      primary: null,
      secondary: OPEN_SETTINGS,
      rows: [
        {
          label: "What is true right now",
          sub: "every photograph on this device is readable by Photos",
          meta: "granted",
        },
        {
          label: "What happens if you take the grant away",
          sub: "Photos goes dark rather than showing you a stale copy, and nothing on this device is lost",
          meta: "reversible",
        },
      ],
    };
  }
  if (state === "limited") {
    return {
      headline: "Photos can reach some of your camera roll",
      lede: "You gave Photos a chosen set of photographs rather than the whole camera roll. Photos will not pretend to have looked at the rest.",
      primary: { action: "settings", label: "Choose more in Settings" },
      secondary: null,
      rows: [
        {
          label: "What Photos can see",
          sub: "only the photographs you chose",
          meta: readableCount === null ? "" : String(readableCount),
        },
        {
          label: "What Photos cannot see",
          sub: "everything else on this device, including anything taken since you chose",
          meta: "hidden",
          net: true,
        },
        {
          label: "What happens if you choose more",
          sub: "the photographs you add join the timeline on the day they were taken",
          meta: "added",
        },
      ],
    };
  }
  if (state === "denied") {
    return {
      headline: "Photos cannot reach your camera roll",
      lede: "The grant that let Photos read the photographs on this device has been refused. Nothing has been lost: the photographs are still here, and the app goes dark rather than showing you a stale copy.",
      primary: canAskAgain
        ? { action: "ask", label: "Allow access" }
        : OPEN_SETTINGS,
      secondary: canAskAgain ? OPEN_SETTINGS : null,
      rows: [
        {
          label: "What is true right now",
          sub: "every photograph is still on this device",
          meta: "unchanged",
        },
        NOTHING_ROW,
        RESTORED_ROW,
      ],
    };
  }
  return {
    headline: "Photos has not asked for your camera roll yet",
    lede: "Photos reads the photographs on this device to show them back to you. Nothing has been read yet, and nothing will be until you say so.",
    primary: { action: "ask", label: "Allow access" },
    secondary: OPEN_SETTINGS,
    rows: [NOTHING_ROW, RESTORED_ROW],
  };
}
