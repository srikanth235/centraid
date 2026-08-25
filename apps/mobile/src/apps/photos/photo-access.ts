// PERMISSION IS A SURFACE, NOT AN ERROR (§13): an ungranted grant is a state
// the product is designed for, drawn whole. LIMITED is why this is a state
// machine and not a boolean — its third answer makes both "Photos has access"
// and "Photos has no access" false. Never pretend to have looked (§14).
//
// Free of `react-native` and `expo-media-library` imports, so every state's
// copy and offered action is assertable directly.

/** The four cases the screen has distinct copy for. */
export type PhotoAccessState =
  | "granted"
  | "limited"
  | "denied"
  | "undetermined";

/** Structural, so this module never imports the native module. */
export interface PhotoAccessPermission {
  status: "granted" | "denied" | "undetermined";
  /** iOS 14+ only. `undefined` on Android, where there is no limited tier. */
  accessPrivileges?: "all" | "limited" | "none";
  canAskAgain: boolean;
}

export function photoAccessState(
  permission: PhotoAccessPermission
): PhotoAccessState {
  // Ahead of `status`: a limited grant reports `status: "granted"` on iOS, and
  // treating that as full access is the lie this screen exists to prevent.
  if (permission.accessPrivileges === "limited") return "limited";
  if (permission.status === "granted") return "granted";
  return permission.status === "denied" ? "denied" : "undetermined";
}

/**
 * Whether the permission content REPLACES the grid (#712) — never a dead grid,
 * never a banner over one. Unknown is not denied, so `null`/`loading` keep the
 * grid; a takeover happens only when there is nothing readable to hide, since
 * replica photographs need no OS grant.
 *
 * CONSEQUENCE: with vault photographs present and the grant refused, the panel
 * — the only place the grant is asked for — is not drawn, so re-asking means
 * the Settings app. A reachable library beats a reachable prompt.
 */
export function photoAccessTakesOverTimeline({
  state,
  deviceReadableCount,
  vaultReadableCount = 0,
  loading,
}: {
  state: PhotoAccessState | null;
  /** Photographs Photos is reading off THIS device right now. */
  deviceReadableCount: number;
  /** Photographs already here through the replica — no OS grant involved. */
  vaultReadableCount?: number;
  /** The device walk has not finished. */
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
  /** Bordered in `net`: the row saying what Photos cannot reach. */
  net?: true;
}

/**
 * NO "CHOOSE MORE PHOTOGRAPHS" ACTION: the Next API (#573) keeps
 * `presentPermissionsPickerAsync` only to throw, and a filled control that
 * raises is worse than none — limited routes to Settings instead.
 */
export type PhotoAccessAction =
  /** Only offered while the OS will still show the prompt. */
  "ask" | "settings";

export interface PhotoAccessControl {
  action: PhotoAccessAction;
  label: string;
}

export interface PhotoAccessCopy {
  headline: string;
  lede: string;
  /** The one filled control (§18); `null` when there is nothing to ask for. */
  primary: PhotoAccessControl | null;
  /** Plain, never filled. */
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

/** `readableCount: null` leaves the meta column blank rather than printing a
 *  zero the app has not finished counting. */
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
      // Once the OS stops asking, "Allow access" would be a control that
      // cannot fire.
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
