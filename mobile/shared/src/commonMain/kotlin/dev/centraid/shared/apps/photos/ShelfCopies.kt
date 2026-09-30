package dev.centraid.shared.apps.photos

import centraid.core.v1.ContentRef
import centraid.core.v1.ContentUrlRequest
import centraid.core.v1.Envelope
import centraid.core.v1.Request
import dev.centraid.core.CoreOutcome
import dev.centraid.shared.shell.HomeSession

/**
 * A COPY OF SEVERAL ORIGINALS, FOR THE SHELL TO HAND OFF (#1029, the photos
 * port).
 *
 * "Send a copy" and "Download original" over a shelf's selection, and "Send a
 * copy" over the library's ([CopyExportScreen] is what both hand the shell).
 * Neither is a vault write — the bytes leave through the platform's share
 * sheet, or into the device's own photo library — so neither is a
 * `ScreenEffect`: what this file
 * does is the one part both shells need and neither should spell, which is
 * FINDING the originals, and the sentences that report what happened.
 *
 * ## HOW AN ORIGINAL IS FOUND
 *
 * The page door answers for hashes and never for paths, so it is two trips,
 * the lightbox's (`PhotoLightboxBridge.locate`) generalised to a pick of many:
 * `media_asset` for each photograph's content item, then the byte door
 * (`ContentUrlRequest`) for where that item's bytes are on this device. A
 * photograph whose original is not here comes back WITHOUT a path, and is
 * counted rather than silently dropped — a member who sent twelve and whose
 * share sheet held ten is owed the two.
 *
 * ## THE LOCATION IS THE SHELL'S TO STRIP, AND IT FAILS CLOSED
 *
 * A batch offers two answers, not the lightbox's three: "No location" and
 * "Exact location". The third — the place's NAME only — is one sentence per
 * photograph and a batch of twelve has twelve places. A file whose location
 * cannot be taken out is NOT sent ([SHARE_PLACE_NOT_REMOVABLE]'s rule, #816).
 */
public object ShelfCopies {
    /** `ContentUrlRequest`'s own ceiling (`MAX_CONTENT_URLS`), asked in slices. */
    private const val URL_BATCH: Int = 100

    private const val OWNER_TYPE: String = "media.asset"

    /**
     * WHERE EACH PICKED ORIGINAL IS ON THIS DEVICE, in the pick's order, and
     * how many are not here.
     */
    internal suspend fun locate(session: HomeSession, assetIds: List<String>): Located {
        val ids = assetIds.filter { it.isNotEmpty() }.distinct()
        val query = PhotoShelfReads.contentOfQuery(ids) ?: return Located(emptyList(), 0)
        val core = session.shelf.core() ?: return Located(emptyList(), ids.size)
        val rows = (core.photosPage(query, limit = ids.size) as? PhotosPage.Rows)?.rows
            ?: return Located(emptyList(), ids.size)
        val contentOf = rows.associate { row ->
            (row.values.getOrNull(0)?.text ?: "") to
                ((row.values.getOrNull(1)?.text ?: "") to (row.values.getOrNull(2)?.text ?: ""))
        }
        val found = mutableListOf<LocatedOriginal>()
        ids.filter { !contentOf[it]?.first.isNullOrEmpty() }.chunked(URL_BATCH).forEach { slice ->
            val refs = slice.map { assetId ->
                ContentRef(content_id = contentOf.getValue(assetId).first, owner_type = OWNER_TYPE, owner_id = assetId)
            }
            val outcome = core.call(Envelope(request = Request(content_urls = ContentUrlRequest(refs = refs))))
            val urls = (outcome as? CoreOutcome.Answered)?.value?.response?.content_urls?.urls.orEmpty()
            // ONE ANSWER PER REF, IN ORDER (`ContentUrls`' own rule), so the
            // zip is by position and a short answer pairs nothing wrongly.
            slice.forEachIndexed { index, assetId ->
                val url = urls.getOrNull(index)
                val path = url?.path
                if (url != null && url.content_id == refs[index].content_id && !path.isNullOrEmpty()) {
                    found += LocatedOriginal(
                        assetId = assetId,
                        path = path,
                        mediaType = url.media_type,
                        isVideo = contentOf.getValue(assetId).second == "video",
                    )
                }
            }
        }
        return Located(found, ids.size - found.size)
    }

    /** What [locate] found, and how many of the pick it did not. */
    public data class Located(val originals: List<LocatedOriginal>, val missing: Int)

    // -----------------------------------------------------------------------
    // The sentences. One clause each, in `commonMain` so both shells say them.
    // -----------------------------------------------------------------------

    /** Nothing of the pick is on this device. */
    public const val NONE_HERE: String = "The originals are not on this device, so nothing was sent."

    /** Some of the pick was not here. Said beside what did go. */
    public fun missingSentence(missing: Int): String = when (missing) {
        0 -> ""
        1 -> "1 original is not on this device, so it was not included."
        else -> "$missing originals are not on this device, so they were not included."
    }

    /** "Download original" put [count] into the device's photos. */
    public fun savedSentence(count: Int, missing: Int): String {
        val saved = when (count) {
            0 -> ""
            1 -> "Saved to this device's photos."
            else -> "$count saved to this device's photos."
        }
        return listOf(saved, missingSentence(missing)).filter { it.isNotEmpty() }.joinToString(" ")
            .ifEmpty { NONE_HERE }
    }

    /** The platform refused the save or the copy. v0's words and its retry. */
    public const val EXPORT_FAILED_SENTENCE: String = "Photographs not exported. Retry."

    /** A location that could not be taken out stops the whole send. */
    public const val LOCATION_NOT_REMOVABLE: String =
        "The location could not be taken out of every file, so nothing was sent."
}

/**
 * A SCREEN WHOSE PICK CAN BE HANDED TO THE PLATFORM — the photo shelf
 * ([PhotoShelfBridge]) and the library's selection ([LibraryCopies]).
 *
 * The shells' hand-off (`ShelfCopyExport.swift`, `PhotoShelfCopies.kt`) takes
 * this and not a named bridge, so one batch path serves every selection bar
 * that offers "Send a copy": the location is asked once for the pick, the
 * same refusals stop it, and what it came to lands in that screen's own
 * `export_notice`.
 */
public interface CopyExportScreen {
    /** [ShelfCopies.locate] for [assetIds], handed back on the main thread. */
    public fun locateOriginals(assetIds: List<String>, onLocated: (ShelfCopies.Located) -> Unit)

    /** What the shell's copy came to, as the one clause the screen shows. */
    public fun exportSettled(sentence: String)
}

/** One original this device holds, located for a platform hand-off. */
public data class LocatedOriginal(
    val assetId: String,
    val path: String,
    val mediaType: String,
    val isVideo: Boolean,
)
