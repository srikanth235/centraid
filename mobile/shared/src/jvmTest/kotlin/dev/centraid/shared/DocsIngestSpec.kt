package dev.centraid.shared

import centraid.screen.v1.DocsCapture
import centraid.screen.v1.DocsDriveEvent
import centraid.screen.v1.DocsIngestEvent
import centraid.screen.v1.DocsIngestState
import dev.centraid.design.copy.DocsCopy
import dev.centraid.shared.apps.docs.DocsIngestBridge
import dev.centraid.shared.apps.docs.DocsIngestMachine
import dev.centraid.shared.apps.docs.DocsIngestPort
import dev.centraid.shared.shell.Staging
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldStartWith
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import java.io.File
import java.util.Collections

/**
 * Docs' Add sheet: Upload, Scan and Text (#1047, R-1047-Q4). The reducer's
 * phases and words, then the bridge end to end over a fake port — the picker
 * the shell supplies, the stage frames, `core.add_document` over the staged
 * hash and `core.create_text_document`.
 */
class DocsIngestSpec : StringSpec({

    fun reduce(state: DocsIngestState, vararg events: DocsIngestEvent): DocsIngestState =
        events.fold(state) { s, e -> DocsIngestMachine.reduce(s, e).state }

    fun requested(kind: DocsDriveEvent.AddRequested.Kind, folder: String = "") =
        DocsIngestEvent(requested = DocsIngestEvent.Requested(kind = kind, folder_id = folder, document_id = "d-new"))

    "upload: picking, staging with a bar, filing, and the words for each" {
        val picking = reduce(DocsIngestMachine.initial(), requested(DocsDriveEvent.AddRequested.Kind.KIND_UPLOAD, "f-1"))
        picking.phase shouldBe DocsIngestState.Phase.PHASE_PICKING
        picking.status_label shouldBe ""
        picking.request_seq shouldBe 1
        // ONE AT A TIME: a second request while picking is nothing.
        reduce(picking, requested(DocsDriveEvent.AddRequested.Kind.KIND_TEXT)) shouldBe picking

        val staging = reduce(
            picking,
            DocsIngestEvent(picked = DocsIngestEvent.Picked(name = "Lease.pdf", media_type = "", byte_size = 2000)),
            DocsIngestEvent(progressed = DocsIngestEvent.Progressed(staged_bytes = 500)),
        )
        staging.phase shouldBe DocsIngestState.Phase.PHASE_STAGING
        staging.title shouldBe "Lease.pdf"
        staging.progress_permille shouldBe 250
        staging.status_label shouldBe "Adding Lease.pdf"
        staging.file_held shouldBe true

        val filed = reduce(
            staging,
            DocsIngestEvent(staged = DocsIngestEvent.Staged(staged_sha = "h")),
            DocsIngestEvent(settled = DocsIngestEvent.Settled(committed = true)),
        )
        filed.phase shouldBe DocsIngestState.Phase.PHASE_FILED
        filed.status_label shouldBe "Lease.pdf added"
        filed.open_editor shouldBe false
        filed.routed shouldBe false
        // THE ADDED LINE CAN BE PUT AWAY: a close key, no text action (DESIGN.md StatusLine).
        filed.dismiss_label shouldBe DocsCopy.INGEST_DISMISS
        filed.retry_label shouldBe ""
        staging.dismiss_label shouldBe ""
        reduce(filed, DocsIngestEvent(dismissed = DocsIngestEvent.Dismissed())).let {
            it.phase shouldBe DocsIngestState.Phase.PHASE_IDLE
            it.status_label shouldBe ""
            it.dismiss_label shouldBe ""
        }
        reduce(filed, DocsIngestEvent(routed = DocsIngestEvent.Routed(request_seq = 1))).routed shouldBe true
        // A STALE ACKNOWLEDGEMENT routes nothing.
        reduce(filed, DocsIngestEvent(routed = DocsIngestEvent.Routed(request_seq = 7))).routed shouldBe false
    }

    "scan: a scan with no name is a scanned document; a closed picker says nothing" {
        val picking = reduce(DocsIngestMachine.initial(), requested(DocsDriveEvent.AddRequested.Kind.KIND_SCAN))
        reduce(picking, DocsIngestEvent(picked = DocsIngestEvent.Picked(name = " ", byte_size = 10))).title shouldBe
            DocsCopy.INGEST_SCAN_TITLE
        val closed = reduce(picking, DocsIngestEvent(pick_cancelled = DocsIngestEvent.PickCancelled()))
        closed.phase shouldBe DocsIngestState.Phase.PHASE_IDLE
        closed.status_label shouldBe ""
        closed.failure shouldBe null
    }

    "text: straight to filing an untitled document that opens its editor" {
        val filing = reduce(DocsIngestMachine.initial(), requested(DocsDriveEvent.AddRequested.Kind.KIND_TEXT, "f-2"))
        filing.phase shouldBe DocsIngestState.Phase.PHASE_FILING
        filing.title shouldBe DocsCopy.INGEST_TEXT_TITLE
        filing.open_editor shouldBe true
        val (command, input, key) = DocsIngestMachine.filing(filing, "")!!
        command shouldBe "core.create_text_document"
        input shouldBe """{"document_id":"d-new","title":"Untitled document","folder_id":"f-2"}"""
        key shouldBe "core.create_text_document:d-new"
    }

    "a refusal is a failure with Try again: a held file restages, none re-picks" {
        val picking = reduce(DocsIngestMachine.initial(), requested(DocsDriveEvent.AddRequested.Kind.KIND_UPLOAD))
        val refused = reduce(picking, DocsIngestEvent(pick_refused = DocsIngestEvent.PickRefused(sentence = "")))
        refused.phase shouldBe DocsIngestState.Phase.PHASE_FAILED
        refused.status_label shouldBe DocsCopy.INGEST_NO_PICKER
        refused.retry_label shouldBe DocsCopy.RETRY
        refused.dismiss_label shouldBe DocsCopy.INGEST_DISMISS
        reduce(refused, DocsIngestEvent(retried = DocsIngestEvent.Retried())).phase shouldBe DocsIngestState.Phase.PHASE_PICKING

        val stagedThenRefused = reduce(
            picking,
            DocsIngestEvent(picked = DocsIngestEvent.Picked(name = "a.png", byte_size = 4)),
            DocsIngestEvent(settled = DocsIngestEvent.Settled(committed = false, sentence = "The disk is full.")),
        )
        stagedThenRefused.status_label shouldBe "The disk is full."
        reduce(stagedThenRefused, DocsIngestEvent(retried = DocsIngestEvent.Retried())).phase shouldBe
            DocsIngestState.Phase.PHASE_STAGING
        reduce(stagedThenRefused, DocsIngestEvent(dismissed = DocsIngestEvent.Dismissed())).phase shouldBe
            DocsIngestState.Phase.PHASE_IDLE
    }

    "a scanner refused the camera says where to turn it on, not that a file could not be read" {
        DocsIngestMachine.scanRefusal(DocsCapture.Permission.PERMISSION_DENIED) shouldBe DocsCopy.CAMERA_DENIED
        DocsIngestMachine.scanRefusal(DocsCapture.Permission.PERMISSION_RESTRICTED) shouldBe DocsCopy.CAMERA_RESTRICTED
        DocsIngestMachine.scanRefusal(DocsCapture.Permission.PERMISSION_GRANTED) shouldBe DocsCopy.INGEST_NO_FILE
        val picking = reduce(DocsIngestMachine.initial(), requested(DocsDriveEvent.AddRequested.Kind.KIND_SCAN))
        val refused = reduce(
            picking,
            DocsIngestEvent(
                pick_refused = DocsIngestEvent.PickRefused(
                    sentence = DocsIngestMachine.scanRefusal(DocsCapture.Permission.PERMISSION_DENIED),
                ),
            ),
        )
        refused.phase shouldBe DocsIngestState.Phase.PHASE_FAILED
        refused.status_label shouldBe DocsCopy.CAMERA_DENIED
    }

    "the Add sheet's rows are the kinds, and a name says its media type" {
        DocsIngestMachine.kindOf("upload") shouldBe DocsDriveEvent.AddRequested.Kind.KIND_UPLOAD
        DocsIngestMachine.kindOf("scan") shouldBe DocsDriveEvent.AddRequested.Kind.KIND_SCAN
        DocsIngestMachine.kindOf("text") shouldBe DocsDriveEvent.AddRequested.Kind.KIND_TEXT
        DocsIngestMachine.kindOf("new_folder") shouldBe null
        DocsIngestMachine.mediaTypeOf("Lease.PDF", "") shouldBe "application/pdf"
        DocsIngestMachine.mediaTypeOf("scan", "image/jpeg") shouldBe "image/jpeg"
        DocsIngestMachine.mediaTypeOf("mystery.bin", "") shouldBe "application/octet-stream"
    }

    "the bridge: the shell's picker, the stage, then core.add_document over the staged hash" {
        val port = FakePort()
        val bridge = DocsIngestBridge.over(port, Dispatchers.Default)
        val asked = Collections.synchronizedList(mutableListOf<DocsDriveEvent.AddRequested.Kind>())
        val file = File.createTempFile("lease", ".pdf").apply { writeBytes(ByteArray(64)) }
        bridge.onPick = { kind ->
            asked += kind
            bridge.picked(file.absolutePath, "Lease.pdf", "", owned = true)
        }
        try {
            bridge.requestFor("upload", "f-1", "Taxes")
            val filed = withTimeout(5_000) { bridge.host.state.first { it.phase == DocsIngestState.Phase.PHASE_FILED } }
            asked shouldBe listOf(DocsDriveEvent.AddRequested.Kind.KIND_UPLOAD)
            port.staged shouldBe listOf(file.absolutePath to "application/pdf")
            port.writes shouldHaveSize 1
            val (command, input, key) = port.writes.single()
            command shouldBe "core.add_document"
            input shouldBe """{"document_id":"${filed.document_id}","staged_sha":"${FakePort.HASH}","title":"Lease.pdf","folder_id":"f-1"}"""
            key shouldBe "core.add_document:${filed.document_id}:${FakePort.HASH}"
            filed.total_bytes shouldBe 64L
            filed.status_label shouldBe "Lease.pdf added"
            // THE BACK WORD RIDES IN STATE, so the root pushes from anywhere.
            filed.parent shouldBe "Taxes"
            // THE SHELL'S COPY IS THE BRIDGE'S, and goes once the document is filed.
            withTimeout(5_000) { while (file.exists()) delay(10) }
            file.exists() shouldBe false
        } finally {
            file.delete()
            bridge.close()
        }
    }

    "the bridge: Text files an untitled document and opens its editor; no picker is a sentence" {
        val port = FakePort()
        val bridge = DocsIngestBridge.over(port, Dispatchers.Default)
        try {
            bridge.request(DocsDriveEvent.AddRequested.Kind.KIND_TEXT, "", "")
            val filed = withTimeout(5_000) { bridge.host.state.first { it.phase == DocsIngestState.Phase.PHASE_FILED } }
            filed.open_editor shouldBe true
            filed.parent shouldBe DocsCopy.APP_TITLE
            filed.document_id.length shouldBe 36
            port.staged.shouldBeEmpty()
            port.writes.single().first shouldBe "core.create_text_document"
            port.writes.single().second shouldStartWith """{"document_id":"${filed.document_id}","title":"Untitled document"}"""

            bridge.dismiss()
            withTimeout(5_000) { bridge.host.state.first { it.phase == DocsIngestState.Phase.PHASE_IDLE } }
            // UNSET PICKER: Upload says this phone cannot pick, rather than spin.
            bridge.request(DocsDriveEvent.AddRequested.Kind.KIND_UPLOAD, "", "")
            withTimeout(5_000) {
                bridge.host.state.first { it.phase == DocsIngestState.Phase.PHASE_FAILED }
            }.status_label shouldBe DocsCopy.INGEST_NO_PICKER
        } finally {
            bridge.close()
        }
    }

    "the bridge: a refused stage is the core's sentence, and Try again restages the held file" {
        val port = FakePort(refuseFirstStage = "Centraid could not take those bytes.")
        val bridge = DocsIngestBridge.over(port, Dispatchers.Default)
        val file = File.createTempFile("photo", ".png").apply { writeBytes(ByteArray(8)) }
        bridge.onPick = { bridge.picked(file.absolutePath, "photo.png", "image/png", owned = false) }
        try {
            bridge.request(DocsDriveEvent.AddRequested.Kind.KIND_UPLOAD, "", "")
            withTimeout(5_000) {
                bridge.host.state.first { it.phase == DocsIngestState.Phase.PHASE_FAILED }
            }.status_label shouldBe "Centraid could not take those bytes."
            port.writes.shouldBeEmpty()
            bridge.retry()
            withTimeout(5_000) { bridge.host.state.first { it.phase == DocsIngestState.Phase.PHASE_FILED } }
            port.staged shouldHaveSize 2
            // NOT OWNED: the shell's file is left where it was.
            file.exists() shouldBe true
        } finally {
            file.delete()
            bridge.close()
        }
    }
}) {
    private class FakePort(private val refuseFirstStage: String? = null) : DocsIngestPort {
        val staged: MutableList<Pair<String, String>> = Collections.synchronizedList(mutableListOf())
        val writes: MutableList<Triple<String, String, String>> = Collections.synchronizedList(mutableListOf())

        override suspend fun readOnly(): Boolean = false

        override suspend fun stage(path: String, mediaType: String, progress: suspend (Long) -> Unit): Staging.Outcome {
            staged += path to mediaType
            if (refuseFirstStage != null && staged.size == 1) return Staging.Outcome.No(Staging.Refused(refuseFirstStage))
            progress(File(path).length())
            return Staging.Outcome.Ok(Staging.Staged(contentHash = HASH, byteSize = File(path).length(), alreadyHeld = false))
        }

        override suspend fun write(command: String, input: String, invokeKey: String): Pair<Boolean, String> {
            writes += Triple(command, input, invokeKey)
            return true to ""
        }

        companion object {
            const val HASH: String = "b3a1c0ffee"
        }
    }
}
