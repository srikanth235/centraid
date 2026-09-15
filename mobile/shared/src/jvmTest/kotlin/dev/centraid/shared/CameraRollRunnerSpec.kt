package dev.centraid.shared

import centraid.screen.v1.MediaPermission
import centraid.screen.v1.PhotosGridState
import dev.centraid.shared.apps.photos.PhotosGridMachine
import dev.centraid.shared.platform.FakePlatformServices
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.CameraRoll
import dev.centraid.shared.shell.CameraRollRunner
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield

/**
 * THE EXISTING GRANT REACHES THE SCREEN BEFORE ANY ASK (#1025, R-PHOTOS-1).
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
        host: ScreenHost<PhotosGridState, centraid.screen.v1.PhotosGridEvent>,
        scope: CoroutineScope,
    ) = CameraRollRunner(
        services = services,
        roll = CameraRoll(services) { null },
        host = host,
        scope = scope,
        vaultId = { "vault-1" },
    )

    "an existing grant is on the screen as soon as the runner starts, before any ask" {
        runTest(UnconfinedTestDispatcher()) {
            val services = FakePlatformServices()
            services.mediaLibrary.grant = MediaPermission.MEDIA_PERMISSION_GRANTED
            val host = ScreenHost(PhotosGridMachine)
            // Demonstrated red: without syncPermission inside start(), state
            // stayed at the machine's NOT_ASKED seed and paused_reason empty
            // until an ask — the live "Allow photo access" banner.
            runner(services, host, backgroundScope).start()
            yield()

            host.state.value.permission shouldBe MediaPermission.MEDIA_PERMISSION_GRANTED
            host.state.value.backup!!.paused_reason shouldBe ""
            services.mediaLibrary.requests shouldBe 0
        }
    }

    "a limited grant is first-class on start — no Allow button signal, no not-asked reason" {
        runTest(UnconfinedTestDispatcher()) {
            val services = FakePlatformServices()
            services.mediaLibrary.grant = MediaPermission.MEDIA_PERMISSION_LIMITED
            val host = ScreenHost(PhotosGridMachine)
            runner(services, host, backgroundScope).start()
            yield()

            host.state.value.permission shouldBe MediaPermission.MEDIA_PERMISSION_LIMITED
            host.state.value.backup!!.paused_reason shouldNotContain "needs access"
            // Shells offer "Allow photo access" only for NOT_ASKED.
            (host.state.value.permission == MediaPermission.MEDIA_PERMISSION_NOT_ASKED) shouldBe false
            services.mediaLibrary.requests shouldBe 0
        }
    }

    "a grant that arrives after start is visible after syncPermission" {
        runTest(UnconfinedTestDispatcher()) {
            val services = FakePlatformServices()
            services.mediaLibrary.grant = MediaPermission.MEDIA_PERMISSION_NOT_ASKED
            val host = ScreenHost(PhotosGridMachine)
            val roll = runner(services, host, backgroundScope)
            roll.start()
            yield()
            host.state.value.permission shouldBe MediaPermission.MEDIA_PERMISSION_NOT_ASKED
            host.state.value.backup!!.paused_reason shouldBe
                "Centraid needs access to your photos to back them up."

            // Settings (or a launch prompt the attach seed raced): grant lands,
            // cover opens, syncPermission runs before Opened.
            services.mediaLibrary.grant = MediaPermission.MEDIA_PERMISSION_GRANTED
            roll.syncPermission()

            host.state.value.permission shouldBe MediaPermission.MEDIA_PERMISSION_GRANTED
            host.state.value.backup!!.paused_reason shouldBe ""
            services.mediaLibrary.requests shouldBe 0
        }
    }
})
