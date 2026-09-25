package dev.centraid.core

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.Command
import centraid.core.v1.CommandStatus
import centraid.core.v1.DocsActivityRequest
import centraid.core.v1.DocsDocument
import centraid.core.v1.DocsDocumentRequest
import centraid.core.v1.DocsDrive
import centraid.core.v1.DocsDriveRequest
import centraid.core.v1.DocsSearchRequest
import centraid.core.v1.DocsShelf
import centraid.core.v1.DocsSort
import centraid.core.v1.DocsSurface
import centraid.core.v1.Envelope
import centraid.core.v1.Request
import dev.centraid.core.AbiRoundTripSpec.Companion.openRealCore
import dev.centraid.core.AbiRoundTripSpec.Companion.shouldBeAnsweredWith
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.collections.shouldNotContain
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldStartWith
import io.kotest.matchers.types.shouldBeInstanceOf
import okio.ByteString.Companion.encodeUtf8

/**
 * DOCS' QUERIES, KOTLIN TO RUST AND BACK (#1046).
 *
 * The drive's shelves, filters and sort, a document's versions and text, and
 * its activity are `crates/apps/docs`' folds run in the core; the phone sends
 * a typed `docs_*` arm and Wire decodes a typed answer. Over JNA, against the
 * real `libcentraid_core_ffi` and the vault `spike-fixture` founded — nothing
 * faked. Writes go through `Command` requests, the plane a screen uses.
 */
class DocsQueryRoundTripSpec : StringSpec({

    "the drive, a document, search and activity round trip, and the trash is its own shelf" {
        val core = openRealCore()
        try {
            val folder = core.write(
                "core.create_folder",
                """{"name":"Round trip leases"}""",
                key = "docs-round-trip-folder",
                field = "folder_id",
            )
            val lease = core.write(
                "core.add_document",
                """{"title":"Round trip lease","data_uri":"data:text/plain;charset=utf-8,rent",""" +
                    """"folder_id":"$folder"}""",
                key = "docs-round-trip-lease",
                field = "document_id",
            )
            core.write(
                "core.edit_document",
                """{"document_id":"$lease","body_text":"rent is due"}""",
                key = "docs-round-trip-edit",
                field = "document_id",
            )
            val blank = core.write(
                "core.add_document",
                """{"title":"Round trip blank","data_uri":"data:text/plain;charset=utf-8,"}""",
                key = "docs-round-trip-blank",
                field = "document_id",
            )
            val binned = core.write(
                "core.add_document",
                """{"title":"Round trip binned","data_uri":"data:text/plain;charset=utf-8,old"}""",
                key = "docs-round-trip-binned",
                field = "document_id",
            )
            core.write(
                "core.trash_document",
                """{"document_id":"$binned"}""",
                key = "docs-round-trip-trash",
                field = "document_id",
            )

            // --- docs.drive -------------------------------------------------
            val all = core.drive(DocsDriveRequest(tz = TZ))
            val ids = all.documents.map { it.document_id }
            ids shouldContain lease
            ids shouldContain blank
            ids shouldNotContain binned
            val rail = all.folders.single { it.folder_id == folder }
            rail.name shouldBe "Round trip leases"
            rail.parent_id shouldBe ""
            rail.document_count shouldBe 1
            all.now_local shouldStartWith all.today

            val row = all.documents.single { it.document_id == lease }
            row.folder_id shouldBe folder
            row.surface shouldBe DocsSurface.DOCS_SURFACE_READING
            row.kind_name shouldBe "Document"
            // A PHRASE, formatted by the core — never a byte count in a view.
            row.size shouldBe "11 bytes"
            row.updated_local shouldStartWith all.today

            val inFolder = core.drive(
                DocsDriveRequest(
                    shelf = DocsShelf.DOCS_SHELF_FOLDER,
                    folder_id = folder,
                    sort = DocsSort.DOCS_SORT_NAME,
                    ascending = true,
                    tz = TZ,
                ),
            )
            inFolder.documents.map { it.document_id } shouldBe listOf(lease)

            val trash = core.drive(DocsDriveRequest(shelf = DocsShelf.DOCS_SHELF_TRASH, tz = TZ))
            val gone = trash.documents.single { it.document_id == binned }
            gone.trashed shouldBe true
            gone.purge_in_days shouldBe 30
            gone.purge_local_day shouldNotBe ""

            // --- docs.document ----------------------------------------------
            val opened = core.document(lease)
            opened.document?.title shouldBe "Round trip lease"
            opened.body shouldBe "rent is due"
            opened.path.map { it.folder_id } shouldBe listOf(folder)
            opened.versions.map { it.number } shouldBe listOf(2, 1)
            opened.versions.first().current shouldBe true
            // ABSENT IS NOT EMPTY: an empty text document's body is "".
            core.document(blank).body shouldBe ""
            core.document("no-such-document").document shouldBe null

            // --- docs.search ------------------------------------------------
            core.appQuery(
                AppQueryRequest(docs_search = DocsSearchRequest(term = "rent", limit = 10, tz = TZ)),
            ).shouldBeAnsweredWith { envelope ->
                val found = envelope.response?.app_query?.docs_search
                    ?: error("a search answer, got $envelope")
                found.documents.map { it.document_id } shouldContain lease
            }

            // --- docs.activity ----------------------------------------------
            core.appQuery(
                AppQueryRequest(docs_activity = DocsActivityRequest(document_id = lease, tz = TZ)),
            ).shouldBeAnsweredWith { envelope ->
                envelope.response?.app_query?.docs_activity
                    ?: error("an activity answer, got $envelope")
            }

            // --- the zone rule ----------------------------------------------
            core.appQuery(
                AppQueryRequest(docs_drive = DocsDriveRequest(tz = "Mars/Olympus_Mons")),
            ).shouldBeInstanceOf<CoreOutcome.Failed>()
        } finally {
            core.close()
        }
    }
}) {
    companion object {
        /** The device's zone, as a shell reads it off the platform and states it. */
        private const val TZ = "America/New_York"

        suspend fun CentraidCore.appQuery(query: AppQueryRequest): CoreOutcome<Envelope> =
            call(Envelope(request_id = 1, request = Request(app_query = query)))

        suspend fun CentraidCore.drive(request: DocsDriveRequest): DocsDrive {
            var answer: DocsDrive? = null
            appQuery(AppQueryRequest(docs_drive = request)).shouldBeAnsweredWith { envelope ->
                answer = envelope.response?.app_query?.docs_drive
                    ?: error("a drive answer, got $envelope")
            }
            return answer!!
        }

        suspend fun CentraidCore.document(documentId: String): DocsDocument {
            var answer: DocsDocument? = null
            appQuery(
                AppQueryRequest(docs_document = DocsDocumentRequest(document_id = documentId, tz = TZ)),
            ).shouldBeAnsweredWith { envelope ->
                answer = envelope.response?.app_query?.docs_document
                    ?: error("a document answer, got $envelope")
            }
            return answer!!
        }

        /** One command through the command plane; answers one string field of its output. */
        suspend fun CentraidCore.write(name: String, input: String, key: String, field: String): String {
            var value = ""
            call(
                Envelope(
                    request_id = 1,
                    request = Request(
                        command = Command(name = name, input = input.encodeUtf8(), invoke_key = key),
                    ),
                ),
            ).shouldBeAnsweredWith { envelope ->
                val outcome = envelope.response?.command ?: error("a CommandOutcome")
                outcome.status shouldBe CommandStatus.COMMAND_STATUS_EXECUTED
                value = Regex("\"$field\":\"([^\"]+)\"")
                    .find(outcome.output.utf8())
                    ?.groupValues
                    ?.get(1)
                    ?: error("no $field in ${outcome.output.utf8()}")
            }
            return value
        }
    }
}
