package dev.centraid.shared

import centraid.core.v1.Command
import centraid.core.v1.Envelope
import centraid.core.v1.Response
import centraid.core.v1.StageBegin
import centraid.core.v1.StageBegun
import centraid.core.v1.StageHandle
import centraid.core.v1.StageResponse
import centraid.core.v1.StageSource
import centraid.screen.v1.BackupState
import centraid.screen.v1.MediaPermission
import dev.centraid.core.CentraidCore
import dev.centraid.shared.apps.photos.PhotosGridMachine
import dev.centraid.shared.platform.FakePlatformServices
import dev.centraid.shared.platform.MediaLibrary
import dev.centraid.shared.platform.NetworkStatus
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.CameraRoll
import dev.centraid.shared.shell.CameraRollRunner
import dev.centraid.shared.shell.LibraryFeed
import dev.centraid.shared.shell.Shelf
import dev.centraid.shared.sync.ContentHash
import dev.centraid.shared.sync.DrainAnswer
import dev.centraid.shared.sync.DrainDoor
import dev.centraid.shared.sync.NeededBytes
import dev.centraid.shared.sync.ShelfDrain
import dev.centraid.shared.sync.TransferRule
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import java.security.MessageDigest

/**
 * THE WALKER STREAMS (#1080, the walker; ruling 6), over a scripted core.
 *
 * What crosses the stage door is the whole of the walker's contract with the
 * core, so it is what these cases read: every resource streamed from the
 * library under its `os_ref` with no copy and no stated size, the rows each one
 * commits, the derivatives the platform drew staged against the original's
 * hash, and the iCloud original that waits for a link rather than being
 * fetched behind the member's rule. The SHA-256 here stands in for the core's
 * BLAKE3: what matters is that the walker reads the hash and never makes one.
 */
class CameraRollStreamSpec : StringSpec({

    fun hashOf(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** A core that stages for real, in memory, and remembers every begin and command. */
    class StagingCore(private val held: Set<String> = emptySet()) {
        val begins = mutableListOf<StageBegin>()
        val commands = mutableListOf<Command>()
        val landed = mutableListOf<ByteArray>()
        private val open = mutableMapOf<String, java.io.ByteArrayOutputStream>()

        val core: CentraidCore = CentraidCore.answering(Dispatchers.Unconfined) { envelope ->
            val request = envelope.request!!
            val begin = request.stage?.begin
            val chunk = request.stage?.chunk
            val end = request.stage?.end
            val command = request.command
            when {
                begin != null -> {
                    begins.add(begin)
                    val id = "s${begins.size}"
                    open[id] = java.io.ByteArrayOutputStream()
                    Envelope(response = Response(stage = StageResponse(begun = StageBegun(staging_id = id, chunk_bytes = 4))))
                }
                chunk != null -> {
                    open.getValue(chunk.staging_id).write(chunk.payload.toByteArray())
                    Envelope(response = Response(stage = StageResponse()))
                }
                end != null -> {
                    val bytes = open.remove(end.staging_id)!!.toByteArray()
                    landed += bytes
                    val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
                    Envelope(
                        response = Response(
                            stage = StageResponse(
                                handle = StageHandle(
                                    content_hash = hash,
                                    byte_size = bytes.size.toLong(),
                                    already_held = hash in held,
                                ),
                            ),
                        ),
                    )
                }
                command != null -> {
                    commands.add(command)
                    Envelope(response = Response())
                }
                else -> Envelope(response = Response())
            }
        }
    }

    fun asset(id: String, live: Boolean = false) = MediaLibrary.Asset(
        localId = id,
        bytes = 0,
        capturedAtIso = "2026-02-03T10:11:12Z",
        capturedUtcOffsetMinutes = 0,
        kind = MediaLibrary.Kind.PHOTO,
        captureGroupId = if (live) id else null,
        resources = buildList {
            add(MediaLibrary.Resource(MediaLibrary.Resource.Role.ORIGINAL, id))
            if (live) add(MediaLibrary.Resource(MediaLibrary.Resource.Role.PAIRED_VIDEO, "$id#pairedVideo"))
        },
    )

    fun library(vararg assets: MediaLibrary.Asset, bytes: Map<String, ByteArray>): FakePlatformServices {
        val services = FakePlatformServices()
        services.mediaLibrary.grant = MediaPermission.MEDIA_PERMISSION_GRANTED
        services.mediaLibrary.assets = assets.toList()
        services.mediaLibrary.originals = bytes
        // PHOTOS STATES NO SIZE: the stage door is told "unknown" (A8).
        services.mediaLibrary.statesSize = false
        services.mediaLibrary.renders = { ref, tier -> "${tier.wire}:$ref".encodeToByteArray() }
        return services
    }

    val still = "a still, nine bytes".encodeToByteArray()
    val movie = "a movie".encodeToByteArray()

    "a runner that follows the session walks the roll now, and before Back up now's pass (#1080, R-1029-PH-4)" {
        runTest(UnconfinedTestDispatcher()) {
            // A PHOTOGRAPH TAKEN WHILE CENTRAID WAS CLOSED: on the simulator it
            // was not in the vault after the app opened, nor after "Back up now".
            val services = library(asset("A"), bytes = mapOf("A" to still, "B" to movie))
            val core = StagingCore()
            val asked = mutableListOf<Boolean>()
            val drain = ShelfDrain(
                holdings = { listOf(Shelf.Holding(vaultId = "vault-1", path = "/v", name = "v", core = core.core)) },
                doorFor = { DrainDoor { input -> asked += input.asked; DrainAnswer(0, DrainAnswer.Stopped.EMPTY) } },
                nowMs = { 0 },
            )
            val runner = CameraRollRunner(
                services = services,
                roll = CameraRoll(services, core = { core.core }),
                host = ScreenHost(PhotosGridMachine),
                scope = backgroundScope,
                vaultId = { "vault-1" },
            )
            runner.follow(drain)
            core.landed.map { it.decodeToString() } shouldBe listOf(still.decodeToString(), "thumb:A", "preview:A")
            services.mediaLibrary.assets = listOf(asset("A"), asset("B"))
            drain.backUpNow()
            // B WALKED IN BEFORE THE ASKED PASS, and A was not offered again.
            core.landed.map { it.decodeToString() }.drop(3) shouldBe listOf(movie.decodeToString(), "thumb:B", "preview:B")
            asked shouldBe listOf(true)
        }
    }

    "a photograph streams from the library under its os_ref, commits, then stages its two derivatives" {
        runTest {
            val services = library(asset("A"), bytes = mapOf("A" to still))
            val core = StagingCore()
            val report = CameraRoll(services, core = { core.core }).pass("vault-1")
            report.queued shouldBe 1
            report.state.phase shouldBe BackupState.Phase.PHASE_DONE

            val original = core.begins.first()
            original.source shouldBe StageSource.STAGE_SOURCE_OS_LIBRARY
            original.os_ref shouldBe "A"
            // NO COPY TO MEASURE: zero is "unknown", and the bytes arrive whole.
            original.byte_size shouldBe 0L
            core.landed.first().contentEquals(still) shouldBe true

            val hash = hashOf(still)
            core.commands.single().invoke_key shouldBe "media.add_asset:$hash"
            core.commands.single().input.utf8() shouldContain "\"staged_sha\":\"$hash\""

            // THE PLATFORM DREW THEM; the core files them under the original.
            val derivatives = core.begins.drop(1)
            derivatives.map { it.tier } shouldBe listOf("thumb", "preview")
            derivatives.forEach { begin ->
                begin.for_hash shouldBe ContentHash.raw(hash)
                begin.media_type shouldBe "image/jpeg"
                begin.source shouldBe StageSource.STAGE_SOURCE_OWNED
                begin.os_ref shouldBe ""
            }
            services.mediaLibrary.rendered.map { it.first } shouldBe listOf("A", "A")
            services.secureStore.read(CameraRoll.cursorKey("vault-1")) shouldBe "A"
        }
    }

    "a Live Photo is one asset: two resources streamed, two rows in one capture group, derivatives for the still" {
        runTest {
            val services = library(asset("L", live = true), bytes = mapOf("L" to still, "L#pairedVideo" to movie))
            val core = StagingCore()
            CameraRoll(services, core = { core.core }).pass("vault-1").queued shouldBe 1
            core.begins.filter { it.source == StageSource.STAGE_SOURCE_OS_LIBRARY }.map { it.os_ref } shouldBe
                listOf("L", "L#pairedVideo")
            val inputs = core.commands.map { it.input.utf8() }
            inputs.size shouldBe 2
            inputs[0] shouldContain "\"kind\":\"photo\""
            inputs[1] shouldContain "\"kind\":\"video\""
            inputs.forEach { it shouldContain "\"capture_group_id\":\"L\"" }
            services.mediaLibrary.rendered.map { it.first }.toSet() shouldBe setOf("L")
        }
    }

    "an original only in iCloud waits for Wi-Fi with the cursor before it, and is fetched once it may be" {
        runTest {
            val services = library(asset("A"), asset("B"), asset("C"), bytes = mapOf("A" to still, "B" to movie, "C" to still))
            services.mediaLibrary.inCloud = setOf("B")
            services.networkStatus.reading = NetworkStatus.Reading(online = true, metered = true, charging = false)
            val core = StagingCore()
            val roll = CameraRoll(services, core = { core.core })

            // STAGING IS LOCAL: the photograph on the phone goes in on cellular.
            val first = roll.pass("vault-1")
            first.queued shouldBe 1
            first.waitingInCloud shouldBe 1
            first.state.phase shouldBe BackupState.Phase.PHASE_WAITING_FOR_UNMETERED
            first.state.paused_reason shouldBe CameraRoll.IN_CLOUD_SENTENCE
            services.mediaLibrary.asked shouldBe listOf("A" to false, "B" to false)
            services.secureStore.read(CameraRoll.cursorKey("vault-1")) shouldBe "A"

            services.networkStatus.reading = NetworkStatus.Reading(online = true, metered = false, charging = false)
            val second = roll.pass("vault-1")
            second.queued shouldBe 2
            services.mediaLibrary.asked.drop(2) shouldBe listOf("B" to true, "C" to true)
            second.state.phase shouldBe BackupState.Phase.PHASE_DONE
        }
    }

    "a re-walk renders nothing: an original the core already holds kept its derivatives" {
        runTest {
            val services = library(asset("A"), bytes = mapOf("A" to still))
            val core = StagingCore(held = setOf(hashOf(still)))
            val report = CameraRoll(services, core = { core.core }).pass("vault-1")
            report.alreadyHeld shouldBe 1
            services.mediaLibrary.rendered.shouldBeEmpty()
            core.begins.size shouldBe 1
        }
    }

    "a still that is gone skips the asset; a movie that is gone costs the still nothing" {
        runTest {
            val gone = library(asset("A"), bytes = emptyMap())
            CameraRoll(gone, core = { StagingCore().core }).pass("vault-1").skipped shouldBe 1

            val services = library(asset("L", live = true), bytes = mapOf("L" to still))
            val core = StagingCore()
            CameraRoll(services, core = { core.core }).pass("vault-1").queued shouldBe 1
            core.commands.single().input.utf8() shouldContain "\"kind\":\"photo\""
        }
    }

    "the need_bytes feed streams each ask by its os_ref, and only the hash asked for counts" {
        runTest {
            val services = library(asset("A"), bytes = mapOf("A" to still, "V" to movie))
            val core = StagingCore()
            val feed = LibraryFeed(services) { vault -> core.core.takeIf { vault == "vault-1" } }
            val landed = feed.feed(
                "vault-1",
                listOf(
                    NeededBytes(hashOf(still), "A", "image/heic", still.size.toLong()),
                    // THE LIBRARY'S BYTES MOVED ON (an edit, a re-save): not the ask.
                    NeededBytes(hashOf(movie), "A", "image/heic", 0),
                    NeededBytes(hashOf(still), "", "image/heic", 0),
                    NeededBytes(hashOf(still), "gone", "image/heic", 0),
                ),
            )
            landed shouldBe 1
            val begin = core.begins.first()
            begin.source shouldBe StageSource.STAGE_SOURCE_OS_LIBRARY
            begin.os_ref shouldBe "A"
            begin.media_type shouldBe "image/heic"
            begin.byte_size shouldBe still.size.toLong()
            feed.feed("vault-2", listOf(NeededBytes(hashOf(still), "A", "image/heic", 0))) shouldBe 0
        }
    }

    "the feed downloads from iCloud only where the rule lets it cross the link" {
        runTest {
            val services = library(bytes = mapOf("P" to still, "V" to movie))
            services.mediaLibrary.inCloud = setOf("P", "V")
            services.powerAndLink.metered = true
            TransferRule.write(services.secureStore, TransferRule.WIFI_AND_CELLULAR_PHOTOS)
            val core = StagingCore()
            val feed = LibraryFeed(services) { core.core }
            feed.feed(
                "vault-1",
                listOf(
                    NeededBytes(hashOf(still), "P", "image/heic", 0),
                    NeededBytes(hashOf(movie), "V", "video/quicktime", 0),
                ),
            ) shouldBe 1
            // A VIDEO NEVER CROSSES A METERED LINK; an unknown link is metered.
            services.mediaLibrary.asked shouldBe listOf("P" to true, "V" to false)
            services.powerAndLink.metered = null
            feed.feed("vault-1", listOf(NeededBytes(hashOf(still), "P", "image/heic", 0)))
            services.mediaLibrary.asked.last() shouldBe ("P" to true)
            TransferRule.write(services.secureStore, TransferRule.WIFI_ONLY)
            feed.feed("vault-1", listOf(NeededBytes(hashOf(still), "P", "image/heic", 0)))
            services.mediaLibrary.asked.last() shouldBe ("P" to false)
        }
    }
})
