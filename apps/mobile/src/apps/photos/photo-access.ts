// PERMISSION IS A SURFACE, NOT AN ERROR (Photos v4 handoff §13, CHANGELOG A.6,
// proto:4335-4349 — the prototype's dedicated `permission` tab).
//
// The prototype states the grammar: a display headline, one paragraph in the
// reading register, one filled ask, and then ruled rows for what is true right
// now, what Photos can see, and what happens if the grant returns. It is drawn
// as a whole surface because an ungranted grant is not a fault — it is a state
// the product is designed for.
//
// ON THE PHONE THE GRANT IS THE OPERATING SYSTEM'S. The prototype's instance is
// a host grant over a library; mobile's instance is the photo-library
// permission iOS and Android hand out, which has a third answer neither of the
// other surfaces has: LIMITED. Limited is why this module exists rather than a
// boolean — "Photos has access" is false, "Photos has no access" is false, and
// the honest sentence is the one that says which photographs Photos can see and
// which it cannot. §14's rule for every state applies: never pretend to have
// looked.
//
// This module is free of `react-native` and `expo-media-library` imports so
// every state's copy and every offered action can be asserted directly
// (`photo-access.test.ts`). `PhotoAccessPanel.tsx` renders them and owns the
// handlers; `PhotosHome` asks `photoAccessTakesOverTimeline` (below) whether
// the panel replaces the grid.

/** What the operating system currently allows, reduced to the four cases the
 *  screen has distinct copy for. */
export type PhotoAccessState =
  | "granted"
  | "limited"
  | "denied"
  | "undetermined";

/** The shape `expo-media-library` answers with, narrowed to what decides the
 *  state. Taken structurally so this module never imports the native module. */
export interface PhotoAccessPermission {
  status: "granted" | "denied" | "undetermined";
  /** iOS 14+ only. `undefined` on Android, where there is no limited tier. */
  accessPrivileges?: "all" | "limited" | "none";
  canAskAgain: boolean;
}

export function photoAccessState(
  permission: PhotoAccessPermission
): PhotoAccessState {
  // `accessPrivileges` decides ahead of `status` on iOS: a limited grant
  // reports `status: "granted"`, and treating it as full access is exactly the
  // lie this screen exists to prevent.
  if (permission.accessPrivileges === "limited") return "limited";
  if (permission.status === "granted") return "granted";
  return permission.status === "denied" ? "denied" : "undetermined";
}

/**
 * WHETHER THE PERMISSION CONTENT REPLACES THE GRID (issue #712, P13).
 *
 * The rule this predicate exists to make assertable: a timeline that cannot be
 * produced must SAY so where it would have been drawn. Never a dead grid, and
 * never a banner over one — §13 makes the ungranted grant a designed state, so
 * it takes the whole content slot while the band above and below it stays
 * exactly where it was.
 *
 * Every branch is a refusal to guess:
 *
 *   - `null` is the frame before the OS has answered. Unknown is not denied,
 *     and a takeover that appears for one frame and vanishes is worse than the
 *     grid's own skeleton, which is the honest loading state (§14).
 *   - `loading` is the device walk still running. Same reason.
 *   - `limited` takes over ONLY when the chosen set is empty. A member who
 *     picked twelve photographs should see those twelve; the panel would be
 *     hiding the very thing they granted.
 *   - `denied` and `undetermined` take over only when the vault has nothing
 *     either. The camera-roll grant governs what Photos may read OFF THIS
 *     DEVICE; it says nothing about photographs that arrived through the
 *     replica, which need no operating-system permission and are already on
 *     the phone. Refusing the OS prompt on a phone holding a seeded or synced
 *     library must not blank the whole grid — the member's own vault
 *     photographs, the shelves, and the route into face review with them —
 *     behind a panel explaining a permission none of that content needs. That
 *     is the same defect the `limited` branch already names one line up: the
 *     panel hiding the very thing it is not about.
 *
 * CONSEQUENCE, stated rather than hidden: when the vault carries photographs
 * and the OS grant is refused, this panel is not drawn, and the panel is the
 * only place the grant is asked for (`photos-band.ts` deliberately dropped the
 * `Photo access` row). Re-asking then means the system Settings app. That is
 * the correct trade — a reachable library with a longer road back to the
 * prompt beats an unreachable library — but it is a real edge, and giving the
 * question a home that does not cost the grid is follow-up work, not a reason
 * to keep blanking the grid meanwhile.
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

/** One ruled row (proto:4339-4341): what it is about, what is true, and the
 *  mono word in the trailing column. */
export interface PhotoAccessRow {
  label: string;
  sub: string;
  meta: string;
  /** Bordered in `net` — the row that says what Photos cannot reach. */
  net?: true;
}

/**
 * What a control on this screen does. The screen maps each to a real handler;
 * an action key with no handler fails to typecheck there, which is the whole
 * reason the availability lives in this table rather than in JSX.
 */
// WHY THERE IS NO "CHOOSE MORE PHOTOGRAPHS" ACTION. iOS has a system modal for
// widening a limited selection, and `expo-media-library` names it
// `presentPermissionsPickerAsync`. The Next API this app is on (#573) keeps
// the symbol only to throw `errorOnLegacyMethodUse` — there is no working call
// behind it. A filled control that raises an exception is worse than no control,
// so the limited state routes to Settings, where iOS's own "Edit Selected
// Photos" lives. Add the in-app modal back the day the module ships one.
export type PhotoAccessAction =
  /** Raise the OS prompt. Only offered while the OS will still show it. */
  | "ask"
  /** Open this app's page in the OS settings, where the grant is changed. */
  | "settings";

export interface PhotoAccessControl {
  action: PhotoAccessAction;
  label: string;
}

export interface PhotoAccessCopy {
  headline: string;
  lede: string;
  /** The one filled control (§18), or `null` where there is nothing to ask
   *  for — a granted grant has no ask, and offering one would be theatre. */
  primary: PhotoAccessControl | null;
  /** Plain, never filled. */
  secondary: PhotoAccessControl | null;
  rows: PhotoAccessRow[];
}

/** The row that never changes shape between the three ungranted states. */
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

/**
 * The screen, for one state.
 *
 * @param readableCount How many photographs Photos is currently reading off
 *   this device. Only the limited state prints it, and only when it is known —
 *   `null` leaves the meta column blank rather than printing a zero the app
 *   has not finished counting.
 */
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
      // The route out of limited is the OS's own settings page — see the note
      // on `PhotoAccessAction` for why there is no in-app picker here.
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
      // proto:4336, with the host grant replaced by the OS grant and the
      // storage noun replaced by the thing a member on a phone recognises.
      lede: "The grant that let Photos read the photographs on this device has been refused. Nothing has been lost: the photographs are still here, and the app goes dark rather than showing you a stale copy.",
      // Once the OS has stopped asking, the prompt is gone for good and the
      // only route left is Settings. Offering "Allow access" then would be a
      // control that cannot fire.
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
