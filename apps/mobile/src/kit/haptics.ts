/**
 * THE ONE MOMENT CHANNEL (#1015, S15).
 *
 * The audit found `expo-haptics` reached for directly in six app and shell
 * files, each picking its own feedback type for its own reason: a launcher
 * tile buzzed on every press-in, onboarding fired a success notification for
 * arriving at a screen, and a real destructive write that landed said nothing
 * at all. Haptics stopped meaning anything, because everything meant it.
 *
 * There are exactly three moments worth a buzz, and this module is the only
 * place that names them:
 *
 *  - `hapticSelect()` — the member moved the band to another place. A
 *    selection tick: the lightest thing the hardware has.
 *  - `hapticMode()` — a long-press changed the MODE of a surface (a grid
 *    entering selection). Not "a long-press happened": the mode changed.
 *  - `hapticLanded()` — a destructive write LANDED. Not the confirm opening,
 *    not the optimistic paint: the moment the thing is gone.
 *
 * Nothing else. A press is not a moment; a navigation is not a moment; a
 * screen appearing is not a moment. `scripts/lint-mobile-rooms.mjs` keeps
 * `expo-haptics` out of every tree but this file.
 *
 * Every call is fire-and-forget and swallows its own failure. Haptics are
 * absent on web, absent on a simulator, and absent on hardware the member has
 * silenced — none of which is an error worth a member's attention, and none
 * of which may ever take down the interaction the buzz was decorating.
 */

import * as Haptics from "expo-haptics";

/** Nothing here is worth an unhandled rejection. */
function fire(run: () => Promise<void>): void {
  try {
    void run().catch(() => undefined);
  } catch {
    // The native module is missing entirely (web, a bare test renderer).
  }
}

/** The band moved to another place. */
export function hapticSelect(): void {
  fire(() => Haptics.selectionAsync());
}

/** A long-press changed the surface's mode — a grid entered selection. */
export function hapticMode(): void {
  fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
}

/** A destructive write landed: the thing is gone. */
export function hapticLanded(): void {
  fire(() =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
  );
}
