package dev.centraid.shared.sync

import centraid.core.v1.SyncBudget
import centraid.core.v1.SyncWindow
import dev.centraid.shared.platform.BackgroundTasks
import dev.centraid.shared.platform.NetworkStatus
import dev.centraid.shared.platform.PlatformServices

/**
 * WHICH WINDOW THIS PASS GETS (#1025 S5).
 *
 * `HomeSession.syncNow` sent `Command(name = "seat.sync")` with no
 * `sync_window` at all, so `crates/blobs` fell back to `Budget::foreground()`
 * on every pass: a thirty-second cellular refresh and a night on the charger
 * asked for exactly the same four gigabytes. This is the function that decides
 * between them, and it lives in `commonMain` because the decision is the same
 * on both phones and a rule that lives in each shell is a rule one shell gets
 * wrong — the reason [WriteGate] is a gate and not a branch per screen.
 *
 * ## Three inputs, and none of them is a guess
 *
 * * the [WakeReason] — the shell knows why it is running;
 * * [TransferRule] — the member's own setting, out of the secure store;
 * * [NetworkStatus.Reading] — the platform's real answer, asked for rather
 *   than assumed from a radio (`docs/mobile-offline.md:212`);
 * * [BackgroundTasks.PlatformWindow] — the deadline the platform stated for
 *   this wake.
 *
 * ## THE WINDOW CARRIES THE SELECTOR, NEVER THE NUMBERS
 *
 * `SyncWindow.budget_bytes` and `budget_items` are left absent on purpose.
 * `crates/blobs`'s `Budget::{short_refresh, night_shift, foreground}` owns the
 * sizes; a Kotlin copy of 8 MiB and 400 items would be a second copy of that
 * crate's reasoning, drifting from the Rust the moment either number changed.
 * The proto's own comment says so. The selector names the decision and the
 * crate that knows the sizes keeps them.
 *
 * ## An unknown answer spends like a metered one
 *
 * [NetworkStatus.Reading.platformRefused] counts as metered, matching
 * [WriteGate]'s treatment of an unknown reachability answer as not-reachable.
 * The asymmetry is the member's bill: a guess that is wrong towards "cheap"
 * spends a data plan, and a guess that is wrong towards "expensive" delays a
 * photograph.
 */
public object SyncWindowPolicy {

    /**
     * The whole decision, pure. [current] is the call a shell makes; this is
     * the one a test drives.
     */
    public fun window(
        wake: WakeReason,
        reading: NetworkStatus.Reading,
        platform: BackgroundTasks.PlatformWindow,
        rule: TransferRule = TransferRule.DEFAULT,
        tail: Boolean = false,
    ): SyncWindow {
        // THE LINK IS EXPENSIVE, OR THE PLATFORM WOULD NOT SAY — the same
        // answer either way, for the reason in the class comment.
        val expensive = reading.metered || reading.platformRefused
        val budget = when {
            // A foreground pass is a FOREGROUND window even on cellular. What
            // bounds it is the member closing the app, and the metered bit
            // below still keeps originals off a data plan.
            wake == WakeReason.FOREGROUND -> SyncBudget.SYNC_BUDGET_FOREGROUND

            // The night shift: charging, unmetered, and the gateway usually one
            // LAN hop away because that is where the charger is.
            reading.charging && !expensive -> SyncBudget.SYNC_BUDGET_NIGHT_SHIFT

            // A MEMBER WHO SAID "PHOTOS ON CELLULAR TOO" GETS THE NIGHT SHIFT
            // ON THE CHARGER ANYWAY, and a member on the default does not —
            // the one place the rule moves the BUDGET rather than only the
            // tiers. The window is still `metered`, and what that buys is a
            // night of thumbnails, previews and photograph originals, with the
            // videos still waiting: "unmetered" is the platform's word for a
            // link, and a tethered phone on a charger is a night shift,
            // metered.
            reading.charging && rule == TransferRule.WIFI_AND_CELLULAR_PHOTOS ->
                SyncBudget.SYNC_BUDGET_NIGHT_SHIFT

            else -> SyncBudget.SYNC_BUDGET_SHORT_REFRESH
        }
        return SyncWindow(
            deadline_ms = platform.deadlineMs,
            budget = budget,
            // THE PLATFORM'S ANSWER, AND ONLY THE PLATFORM'S (#1025 S4).
            //
            // The member's half used to be folded in here — `never` set the
            // metered bit over an unmetered radio — and that was the shape
            // that could not say `MANUAL`: "the member wants nothing
            // automatic" and "this link costs money" are separately true, and
            // a phone on unlimited fibre under a manual rule is the case a
            // single flag cannot describe. They are two fields now.
            metered = expensive,
            // THE MEMBER'S RULE, CARRIED WHOLE. The core does the arithmetic;
            // nothing here computes which tier crosses.
            originals = rule.toWire(),
            // ONE MECHANISM, THREE OCCASIONS (#1025 S2, D-1025-S7-40). The
            // caller says whether this window holds the log stream open; the
            // policy decides nothing about it, because "is the member looking
            // at this vault" is not a fact about the radio or the budget.
            tail = tail,
        )
    }

    /**
     * The one call a shell makes. Asks the platform for both facts and reads
     * the member's preference, then decides.
     */
    public suspend fun current(
        wake: WakeReason,
        services: PlatformServices,
        tail: Boolean = false,
    ): SyncWindow = window(
        wake = wake,
        reading = services.networkStatus.current(),
        platform = services.backgroundTasks.window(wake),
        rule = TransferRule.read(services.secureStore),
        tail = tail,
    )
}
