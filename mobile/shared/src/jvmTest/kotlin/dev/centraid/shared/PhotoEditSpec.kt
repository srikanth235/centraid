package dev.centraid.shared

import centraid.core.v1.Command
import centraid.core.v1.CommandOutcome
import centraid.core.v1.CommandStatus
import centraid.core.v1.Envelope
import centraid.core.v1.Response
import centraid.core.v1.StageBegin
import centraid.core.v1.StageBegun
import centraid.core.v1.StageHandle
import centraid.core.v1.StageResponse
import centraid.screen.v1.MediaPermission
import dev.centraid.core.CentraidCore
import dev.centraid.shared.apps.photos.PhotoFold
import dev.centraid.shared.platform.FakePlatformServices
import dev.centraid.shared.platform.LibraryRefs
import dev.centraid.shared.platform.MediaLibrary
import dev.centraid.shared.shell.CameraRoll
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import okio.ByteString.Companion.encodeUtf8
import java.security.MessageDigest

/**
 * A PHOTO EDITED IN THE PHONE'S OWN PHOTOS APP COMES IN (#1127, A20, R-1127-5).
 *
 * What is proved is what the shared half DECIDES: which resources an edited
 * asset stages and in what order, what each commit names, that a re-offer is
 * the same bytes and the same writes (the core adopts by content, R-1088-12),
 * which library changes are worth offering, and what the refs spell. What
 * iOS's change token returns is `WalkerPlatformLawSpec`'s scan and the owner's
 * device run.
 */
class PhotoEditSpec : StringSpec({

    fun hashOf(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /**
     * A core that stages for real and ANSWERS `media.add_asset` the way the
     * vault does: the asset id is a function of the bytes, so the same hash
     * committed twice is the same asset (`deduped`), which is the property a
     * re-walk's safety rests on.
     */
    class Core {
        val begins = mutableListOf<StageBegin>()
        val commands = mutableListOf<Command>()
        private val open = mutableMapOf<String, java.io.ByteArrayOutputStream>()
        private val assetsByHash = mutableMapOf<String, String>()

        val core: CentraidCore = CentraidCore.answering(Dispatchers.Unconfined) { envelope ->
            val request = envelope.request!!
            val begin = request.stage?.begin
            val chunk = request.stage?.chunk
            val end = request.stage?.end
            val command = request.command
            when {
                begin != null -> {
                    begins += begin
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
                    Envelope(
                        response = Response(
                            stage = StageResponse(
                                handle = StageHandle(
                                    content_hash = hashOf(bytes),
                                    byte_size = bytes.size.toLong(),
                                ),
                            ),
                        ),
                    )
                }
                command != null -> {
                    commands += command
                    val sha = Regex("\"staged_sha\":\"([0-9a-f]+)\"").find(command.input.utf8())!!.groupValues[1]
                    val made = assetsByHash.getOrPut(sha) { "asset-${assetsByHash.size + 1}" }
                    Envelope(
                        response = Response(
                            command = CommandOutcome(
                                status = CommandStatus.COMMAND_STATUS_EXECUTED,
                                output = "{\"asset_id\":\"$made\"}".encodeUtf8(),
                            ),
                        ),
                    )
                }
                else -> Envelope(response = Response())
            }
        }

        fun assetOf(bytes: ByteArray): String = assetsByHash.getValue(hashOf(bytes))
    }

    val camera = "what the camera wrote".encodeToByteArray()
    val render = "what the edit drew".encodeToByteArray()
    val plain = "an unedited photo".encodeToByteArray()

    fun unedited(id: String) = MediaLibrary.Asset(
        localId = id,
        bytes = 0,
        capturedAtIso = "2019-08-03T10:11:12Z",
        capturedUtcOffsetMinutes = 330,
        resources = listOf(MediaLibrary.Resource(MediaLibrary.Resource.Role.ORIGINAL, id)),
    )

    fun edited(id: String, modified: Long, withCamera: Boolean = true) = MediaLibrary.Asset(
        localId = id,
        bytes = 0,
        capturedAtIso = "2019-08-03T10:11:12Z",
        capturedUtcOffsetMinutes = 330,
        captureGroupId = id,
        resources = buildList {
            if (withCamera) add(MediaLibrary.Resource(MediaLibrary.Resource.Role.CAMERA_ORIGINAL, LibraryRefs.camera(id)))
            add(MediaLibrary.Resource(MediaLibrary.Resource.Role.ORIGINAL, LibraryRefs.rendition(id, modified)))
        },
        edited = true,
    )

    fun services(bytes: Map<String, ByteArray>): FakePlatformServices {
        val services = FakePlatformServices()
        services.mediaLibrary.grant = MediaPermission.MEDIA_PERMISSION_GRANTED
        services.mediaLibrary.originals = bytes
        services.mediaLibrary.statesSize = false
        return services
    }

    "an edited asset stages its camera original first and the render under a ref that names its version" {
        runTest {
            val phone = services(mapOf("E#camera" to camera, "E#r100" to render))
            phone.mediaLibrary.assets = listOf(edited("E", 100))
            val core = Core()
            CameraRoll(phone, core = { core.core }).pass("vault-1").queued shouldBe 1

            core.begins.map { it.os_ref } shouldBe listOf("E#camera", "E#r100")
            // NO BLANKET KEEP: nothing is marked edited at the stage door. What
            // protects a render the next edit replaces is the version its ref
            // names, which the deleter checks against the library (A20(3)).
            core.begins.forEach { it.os_edited shouldBe false }
        }
    }

    "the edit is committed over its original: lineage by the core's own id, and no date or caption of its own" {
        runTest {
            val phone = services(mapOf("E#camera" to camera, "E#r100" to render))
            phone.mediaLibrary.assets = listOf(edited("E", 100))
            val core = Core()
            CameraRoll(phone, core = { core.core }).pass("vault-1")

            val (original, edit) = core.commands.map { it.input.utf8() }
            // THE ORIGINAL COMES IN AS ITSELF: dated, grouped with its edit, no lineage.
            original shouldContain "\"captured_at\":\"2019-08-03T10:11:12Z\""
            original shouldContain "\"capture_group_id\":\"E\""
            original shouldNotContain "source_asset_id"
            // THE EDIT NAMES THE ASSET THE CORE ANSWERED — never the phone's id —
            // and leaves the moment to the core, which keeps the original's.
            edit shouldContain "\"source_asset_id\":\"${core.assetOf(camera)}\""
            edit shouldContain "\"capture_group_id\":\"E\""
            edit shouldNotContain "captured_at"
            edit shouldNotContain "tz_offset_min"
            // NO ADJUSTMENT DATA travels (A20(2)): two photographs and nothing else.
            core.commands.size shouldBe 2
        }
    }

    "an edit made after the import adopts the original already held, so the walk adds one asset" {
        runTest {
            val phone = services(mapOf("E" to camera, "E#camera" to camera, "E#r100" to render))
            phone.mediaLibrary.assets = listOf(unedited("E"))
            val core = Core()
            val roll = CameraRoll(phone, core = { core.core })
            roll.pass("vault-1").queued shouldBe 1
            val imported = core.assetOf(camera)

            // THE MEMBER EDITS IT IN PHOTOS: the library reports the update.
            phone.mediaLibrary.reportChange(edited("E", 100))
            roll.pass("vault-1").queued shouldBe 1

            core.commands.size shouldBe 3
            val commit = core.commands.last().input.utf8()
            // THE CAMERA ORIGINAL IS THE BYTES ALREADY IN THE VAULT: same hash,
            // so the core's answer for it is the asset the first import made.
            core.assetOf(camera) shouldBe imported
            commit shouldContain "\"source_asset_id\":\"$imported\""
        }
    }

    "a re-offer is the same stage and the same writes, so the core adopts both and an edit is never doubled" {
        runTest {
            val phone = services(mapOf("E#camera" to camera, "E#r100" to render))
            phone.mediaLibrary.assets = listOf(edited("E", 100))
            val core = Core()
            CameraRoll(phone, core = { core.core }).pass("vault-1")
            val first = core.commands.map { it.invoke_key to it.input.utf8() }

            // A RESTORED PHONE, A LOST CURSOR: the whole roll again.
            phone.secureStore.write(CameraRoll.cursorKey("vault-1"), "")
            CameraRoll(phone, core = { core.core }).pass("vault-1")

            core.commands.map { it.invoke_key to it.input.utf8() }.drop(2) shouldBe first
            // Two bytes streams, one asset each, however many offers.
            core.commands.map { it.invoke_key }.toSet().size shouldBe 2
        }
    }

    "a camera original the library no longer holds costs the edit nothing but its lineage" {
        runTest {
            val phone = services(mapOf("E#r100" to render))
            phone.mediaLibrary.assets = listOf(edited("E", 100))
            val core = Core()
            CameraRoll(phone, core = { core.core }).pass("vault-1").queued shouldBe 1

            val edit = core.commands.single().input.utf8()
            edit shouldNotContain "source_asset_id"
            // WITHOUT A SOURCE THE EDIT IS DATED BY THE PHONE, as any photograph is.
            edit shouldContain "\"captured_at\":\"2019-08-03T10:11:12Z\""
        }
    }

    "an unedited asset is one stage, one write, no lineage, and its ref is its identifier" {
        runTest {
            val phone = services(mapOf("U" to plain))
            phone.mediaLibrary.assets = listOf(unedited("U"))
            val core = Core()
            CameraRoll(phone, core = { core.core }).pass("vault-1").queued shouldBe 1
            core.begins.map { it.os_ref } shouldBe listOf("U")
            core.commands.single().input.utf8() shouldNotContain "source_asset_id"
        }
    }

    "a library change is offered when it adds an asset or edits one, and a metadata-only update is not" {
        runTest {
            val phone = services(mapOf("E#camera" to camera, "E#r100" to render, "U" to plain, "N" to plain))
            phone.mediaLibrary.assets = emptyList()
            // A favourite on an unedited photograph: updated, not edited.
            phone.mediaLibrary.reportChange(unedited("U"), inserted = false)
            // The member edited another one.
            phone.mediaLibrary.reportChange(edited("E", 100), inserted = false)
            // A new photograph.
            phone.mediaLibrary.reportChange(unedited("N"), inserted = true)
            val core = Core()
            val roll = CameraRoll(phone, core = { core.core })

            val report = roll.pass("vault-1")
            report.enumerated shouldBe 2
            core.begins.map { it.os_ref }.filter { LibraryRefs.identifierOf(it) == "U" } shouldBe emptyList()
            core.begins.map { LibraryRefs.identifierOf(it.os_ref) }.toSet() shouldBe setOf("E", "N")

            // THE CURSOR MOVED PAST ALL THREE: asking again offers nothing, so
            // an edit comes in exactly once.
            val again = roll.pass("vault-1")
            again.enumerated shouldBe 0
            core.commands.size shouldBe 3
        }
    }

    "a ref spells its asset, its part and the version it was read at, and every form names one asset" {
        LibraryRefs.rendition("A/L0/001", 1760000000123) shouldBe "A/L0/001#r1760000000123"
        LibraryRefs.witnessOf("A/L0/001#r1760000000123") shouldBe 1760000000123
        LibraryRefs.witnessOf("A/L0/001") shouldBe null
        LibraryRefs.witnessOf("A/L0/001#camera") shouldBe null
        LibraryRefs.witnessOf("A/L0/001#pairedVideo") shouldBe null
        listOf(
            "A/L0/001",
            LibraryRefs.camera("A/L0/001"),
            LibraryRefs.pairedVideo("A/L0/001"),
            LibraryRefs.rendition("A/L0/001", 5),
        ).forEach { LibraryRefs.identifierOf(it) shouldBe "A/L0/001" }
        LibraryRefs.isCamera("A#camera") shouldBe true
        LibraryRefs.isCamera("A#r5") shouldBe false
        LibraryRefs.isPairedVideo("A#pairedVideo") shouldBe true
    }

    "worth offering: an addition always, an update only when it is an edit" {
        LibraryRefs.worthOffering(insertedSinceToken = true, edited = false) shouldBe true
        LibraryRefs.worthOffering(insertedSinceToken = true, edited = true) shouldBe true
        LibraryRefs.worthOffering(insertedSinceToken = false, edited = true) shouldBe true
        LibraryRefs.worthOffering(insertedSinceToken = false, edited = false) shouldBe false
    }

    "the grid draws the newest photograph of a capture group and never folds an ungrouped one" {
        val fold = PhotoFold.FOLDED
        // The text `crates/vault/tests/page_fold.rs` runs against real rows.
        fold shouldContain "n.capture_group_id = media_asset.capture_group_id"
        fold shouldContain "n.kind = 'photo' AND media_asset.kind = 'photo'"
        // A trashed or archived edit un-folds the original it covered.
        fold shouldContain "n.deleted_at IS NULL AND n.archived_at IS NULL"
        // An editor crop has no group, so R-1029-PH-5's two photographs both draw.
        fold shouldNotContain "source_asset_id IS NOT NULL"
        PhotoFold.LIVE shouldContain fold
    }
})
