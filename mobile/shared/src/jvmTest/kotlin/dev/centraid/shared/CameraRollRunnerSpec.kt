package dev.centraid.shared

import centraid.screen.v1.MediaPermission
import dev.centraid.shared.platform.FakePlatformServices
import dev.centraid.shared.shell.CameraRoll
import dev.centraid.shared.shell.CameraRollRunner
import dev.centraid.shared.shell.CameraRollSeat
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield

/**
 * THE EXISTING GRANT REACHES THE SEAT BEFORE ANY ASK (#1025, R-PHOTOS-1; #1135).
 *
 * Slice 6 seeded permission from `start()`, and the live Photos cover still
 * offered "Allow photo access" after full library access was already granted:
 * the seed raced the first published state, and a grant that landed after
 * session attach was never re-read when the cover opened. These tests pin both
 * halves — start carries the grant without asking, and `syncPermission` moves a
 * late grant onto the banner before Opened.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CameraRollRunnerSpec : StringSpec({

    fun runner(
        services: FakePlatformServices,
        seat: CameraRollSeat,
        scope: CoroutineScope,
    ) = CameraRollRunner(
        services = services,
        roll = CameraRoll(services, core = { null }),
        seat = seat,
        scope = scope,
        vaultId = { "vault-1" },
    )

    "an existing grant is on the seat as soon as the runner starts, before any ask" {
        runTest(UnconfinedTestDispatcher()) {
            val services = FakePlatformServices()
            services.mediaLibrary.grant = MediaPermission.MEDIA_PERMISSION_GRANTED
            val seat = CameraRollSeat()
            // Demonstrated red: without syncPermission inside start(), the seat
            // stayed at NOT_ASKED until an ask — the live "Allow photo access" banner.
            runner(services, seat, backgroundScope).start()
            yield()

            seat.permission.value shouldBe MediaPermission.MEDIA_PERMISSION_GRANTED
            services.mediaLibrary.requests shouldBe 0
        }
    }

    "a limited grant is first-class on start — it is never read as not asked" {
        runTest(UnconfinedTestDispatcher()) {
            val services = FakePlatformServices()
            services.mediaLibrary.grant = MediaPermission.MEDIA_PERMISSION_LIMITED
            val seat = CameraRollSeat()
            runner(services, seat, backgroundScope).start()
            yield()

            seat.permission.value shouldBe MediaPermission.MEDIA_PERMISSION_LIMITED
            services.mediaLibrary.requests shouldBe 0
        }
    }

    "a grant that arrives after start is visible after syncPermission" {
        runTest(UnconfinedTestDispatcher()) {
            val services = FakePlatformServices()
            services.mediaLibrary.grant = MediaPermission.MEDIA_PERMISSION_NOT_ASKED
            val seat = CameraRollSeat()
            val roll = runner(services, seat, backgroundScope)
            roll.start()
            yield()
            seat.permission.value shouldBe MediaPermission.MEDIA_PERMISSION_NOT_ASKED

            // Settings (or a launch prompt the attach seed raced): grant lands,
            // cover opens, syncPermission runs before Opened.
            services.mediaLibrary.grant = MediaPermission.MEDIA_PERMISSION_GRANTED
            roll.syncPermission()

            seat.permission.value shouldBe MediaPermission.MEDIA_PERMISSION_GRANTED
            services.mediaLibrary.requests shouldBe 0
        }
    }

    "the screen's ask is one prompt, and the answer goes back to the seat" {
        runTest(UnconfinedTestDispatcher()) {
            val services = FakePlatformServices()
            services.mediaLibrary.grant = MediaPermission.MEDIA_PERMISSION_NOT_ASKED
            val seat = CameraRollSeat()
            runner(services, seat, backgroundScope).start()
            yield()

            seat.request(CameraRollSeat.Request.ASK_PERMISSION)
            yield()

            services.mediaLibrary.requests shouldBe 1
        }
    }
})
