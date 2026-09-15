package dev.centraid.shared

import centraid.core.v1.SyncBudget
import centraid.core.v1.TransferRule as WireTransferRule
import dev.centraid.shared.platform.BackgroundTasks
import dev.centraid.shared.platform.FakeBackgroundTasks
import dev.centraid.shared.platform.FakePlatformServices
import dev.centraid.shared.platform.NetworkStatus
import dev.centraid.shared.sync.SyncWindowPolicy
import dev.centraid.shared.sync.TransferRule
import dev.centraid.shared.sync.WakeReason
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.test.runTest

/**
 * THE WI-FI AND CHARGER RULES, AS THE WINDOW A PASS IS GIVEN (#1025 S5).
 *
 * One test per rule, because before this slice there were no rules: `syncNow`
 * sent no `sync_window` at all and `crates/blobs` fell back to
 * `Budget::foreground()` on every pass — a thirty-second cellular refresh and
 * a night on the charger asked for exactly the same four gigabytes.
 */
class SyncWindowPolicySpec : StringSpec({

    val platform = BackgroundTasks.PlatformWindow(
        deadlineMs = 30_000,
        source = "a test's platform",
    )

    fun reading(
        metered: Boolean = false,
        charging: Boolean = false,
        platformRefused: Boolean = false,
    ) = NetworkStatus.Reading(
        online = true,
        metered = metered,
        charging = charging,
        platformRefused = platformRefused,
    )

    "a foreground wake is a FOREGROUND window, on any radio" {
        // What bounds a foreground pass is the member closing the app. The
        // metered bit still keeps originals off a data plan, which is why this
        // holds on cellular too.
        listOf(reading(), reading(metered = true)).forEach {
            SyncWindowPolicy.window(WakeReason.FOREGROUND, it, platform).budget shouldBe
                SyncBudget.SYNC_BUDGET_FOREGROUND
        }
    }

    "background, charging and unmetered is the NIGHT SHIFT" {
        // Charging, unmetered, and the gateway usually one LAN hop away
        // because that is where the charger is (`crates/blobs::plan`).
        SyncWindowPolicy.window(
            WakeReason.SCHEDULED,
            reading(charging = true),
            platform,
        ).budget shouldBe SyncBudget.SYNC_BUDGET_NIGHT_SHIFT
    }

    "background otherwise is a SHORT REFRESH" {
        listOf(
            reading(),
            reading(metered = true),
            reading(metered = true, charging = true),
        ).forEach {
            SyncWindowPolicy.window(WakeReason.SCHEDULED, it, platform).budget shouldBe
                SyncBudget.SYNC_BUDGET_SHORT_REFRESH
        }
    }

    "every background wake reason takes the same rules" {
        // PUSH, CONNECTIVITY and DISK_FREED are wakes, not exceptions: only
        // FOREGROUND is different, and it is different because the member is
        // looking at the screen.
        WakeReason.entries.filter { it != WakeReason.FOREGROUND }.forEach { wake ->
            SyncWindowPolicy.window(wake, reading(charging = true), platform)
                .budget shouldBe SyncBudget.SYNC_BUDGET_NIGHT_SHIFT
        }
    }

    "the window's metered bit is the READING'S" {
        // A separate fact from the selector, because it is separately true: a
        // night shift on a tethered phone is a night shift, metered.
        SyncWindowPolicy.window(WakeReason.SCHEDULED, reading(), platform)
            .metered.shouldBeFalse()
        SyncWindowPolicy.window(WakeReason.SCHEDULED, reading(metered = true), platform)
            .metered.shouldBeTrue()
    }

    "platformRefused SPENDS LIKE METERED" {
        // The conservative answer, matching `WriteGate`'s treatment of an
        // unknown reachability answer as not-reachable. A guess wrong towards
        // cheap spends a member's data plan; a guess wrong towards expensive
        // delays a photograph.
        val refused = reading(charging = true, platformRefused = true)
        val window = SyncWindowPolicy.window(WakeReason.SCHEDULED, refused, platform)
        window.metered.shouldBeTrue()
        // AND IT IS NOT A NIGHT SHIFT, even on the charger: the night shift's
        // condition is an unmetered link, and "the platform would not say" is
        // not one.
        window.budget shouldBe SyncBudget.SYNC_BUDGET_SHORT_REFRESH
    }

    "the member's rule and the radio are TWO fields, and `manual` needs both" {
        // #1025 S4, D-1025-S7-60. The rule used to be folded into `metered` —
        // `never` set the bit over an unmetered radio — and that shape could
        // not say `MANUAL` at all: "the member wants nothing automatic" and
        // "this link costs money" are separately true, and a phone on
        // unlimited fibre under a manual rule is the case one flag cannot
        // describe.
        val window = SyncWindowPolicy.window(
            WakeReason.SCHEDULED,
            reading(charging = true),
            platform,
            TransferRule.MANUAL,
        )
        // THE RADIO IS CHEAP AND THE WINDOW SAYS SO. The core is what withholds
        // the originals, from the rule, and it does it on this link too.
        window.metered.shouldBeFalse()
        window.originals shouldBe WireTransferRule.TRANSFER_RULE_MANUAL
        // AND THE RULE DOES NOT MOVE THE BUDGET HERE. `MANUAL` governs the
        // TIERS and the budget is the occasion's — a charging phone on a cheap
        // radio is a night shift whatever the member said about originals,
        // because a night shift under `MANUAL` is still a night of thumbnails
        // and previews, which is the grid. D-1025-S7-60 names exactly ONE place
        // the rule reaches the budget (`WIFI_AND_CELLULAR_PHOTOS` on a metered
        // charger, below); a second one here would make a member who asked for
        // "nothing automatic" wait for a grey grid they never asked to keep.
        // The originals are withheld on this long window by
        // `Budget::admits_original`, in Rust, where the arithmetic lives.
        window.budget shouldBe SyncBudget.SYNC_BUDGET_NIGHT_SHIFT
    }

    "every rule reaches the wire as itself, and the default is Wi-Fi-only" {
        // THE SHELL CARRIES THE VALUE AND DOES NONE OF THE ARITHMETIC
        // (#1025 S4). Which tier crosses under which rule on which link is
        // `centraid_blobs::Budget::admits_original`, in Rust, in one table;
        // this spec asserts only that the member's choice arrives unchanged.
        val onTheWire = { rule: TransferRule ->
            SyncWindowPolicy.window(WakeReason.FOREGROUND, reading(), platform, rule).originals
        }
        onTheWire(TransferRule.WIFI_ONLY) shouldBe WireTransferRule.TRANSFER_RULE_WIFI_ONLY
        onTheWire(TransferRule.WIFI_AND_CELLULAR_PHOTOS) shouldBe
            WireTransferRule.TRANSFER_RULE_WIFI_AND_CELLULAR_PHOTOS
        onTheWire(TransferRule.MANUAL) shouldBe WireTransferRule.TRANSFER_RULE_MANUAL
        // A window nobody named a rule for is the default one, and the default
        // is the conservative one.
        SyncWindowPolicy.window(WakeReason.FOREGROUND, reading(), platform).originals shouldBe
            WireTransferRule.TRANSFER_RULE_WIFI_ONLY
    }

    "NO SIZE AND NO CEILING IS SPELLED IN KOTLIN" {
        // `crates/blobs` owns every number. A shell that computed a byte
        // ceiling for a rule would be a second copy of that crate's reasoning,
        // deciding a member's bill, drifting from the Rust the moment either
        // number changed.
        for (rule in TransferRule.entries) {
            val window =
                SyncWindowPolicy.window(WakeReason.SCHEDULED, reading(), platform, rule)
            window.budget_bytes shouldBe null
            window.budget_items shouldBe null
        }
    }

    "Wi-Fi-only is the DEFAULT, and it denies the night shift a metered charger" {
        // The one place the preference overrides the radio rather than
        // agreeing with it. A member who turned Wi-Fi-only off gets the night
        // shift on a tethered charger — still metered, so still no originals —
        // and a member who left the default on does not.
        TransferRule.DEFAULT shouldBe TransferRule.WIFI_ONLY
        val tethered = reading(metered = true, charging = true)
        SyncWindowPolicy.window(
            WakeReason.SCHEDULED,
            tethered,
            platform,
            TransferRule.WIFI_ONLY,
        ).budget shouldBe SyncBudget.SYNC_BUDGET_SHORT_REFRESH
        val permitted = SyncWindowPolicy.window(
            WakeReason.SCHEDULED,
            tethered,
            platform,
            TransferRule.WIFI_AND_CELLULAR_PHOTOS,
        )
        permitted.budget shouldBe SyncBudget.SYNC_BUDGET_NIGHT_SHIFT
        // THE RULE BUYS A LONGER WINDOW AND NEVER SPELLS THE TIERS. The
        // window stays metered — a tethered phone on a charger is a night
        // shift, metered — and what crosses under that pair is the core's
        // table to read, not this one's.
        permitted.metered.shouldBeTrue()
        permitted.originals shouldBe WireTransferRule.TRANSFER_RULE_WIFI_AND_CELLULAR_PHOTOS
    }

    "an unreadable preference is the conservative default, not a throw" {
        // A phone whose store was written by a newer build must still sync,
        // and the failure mode of an unknown word must be spending less.
        TransferRule.of(null) shouldBe TransferRule.WIFI_ONLY
        TransferRule.of("allow-everything") shouldBe TransferRule.WIFI_ONLY
        TransferRule.of("wifi-and-cellular-photos") shouldBe TransferRule.WIFI_AND_CELLULAR_PHOTOS
    }

    "the deadline is the PLATFORM'S number, carried through untouched" {
        SyncWindowPolicy.window(
            WakeReason.SCHEDULED,
            reading(),
            BackgroundTasks.PlatformWindow(deadlineMs = 12_345, source = "a test's platform"),
        ).deadline_ms shouldBe 12_345UL.toLong()
    }

    "the window carries the SELECTOR and never recomputed byte numbers" {
        // `crates/blobs` owns the sizes. A Kotlin copy of 8 MiB and 400 items
        // would be a second copy of that crate's reasoning, drifting from the
        // Rust the moment either number changed; the proto's own comment says
        // so.
        val window = SyncWindowPolicy.window(WakeReason.SCHEDULED, reading(), platform)
        window.budget_bytes.shouldBeNull()
        window.budget_items.shouldBeNull()
    }

    "`current` asks the platform for both facts and the store for the member's" {
        runTest {
            val services = FakePlatformServices(
                backgroundTasks = FakeBackgroundTasks(
                    windows = mapOf(
                        WakeReason.SCHEDULED to BackgroundTasks.PlatformWindow(
                            deadlineMs = 9_000,
                            source = "a test's platform",
                        ),
                    ),
                ),
            )
            services.networkStatus.reading = reading(metered = true, charging = true)
            TransferRule.write(services.secureStore, TransferRule.WIFI_AND_CELLULAR_PHOTOS)

            val window = SyncWindowPolicy.current(WakeReason.SCHEDULED, services)
            window.deadline_ms shouldBe 9_000L
            window.budget shouldBe SyncBudget.SYNC_BUDGET_NIGHT_SHIFT
            window.metered.shouldBeTrue()
        }
    }
})
