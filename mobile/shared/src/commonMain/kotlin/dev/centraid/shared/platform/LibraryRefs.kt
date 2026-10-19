package dev.centraid.shared.platform

/**
 * THE REFS OF A PHOTO LIBRARY ASSET, AND WHICH CHANGES ARE AN EDIT (#1127, A20).
 *
 * A [MediaLibrary.Resource.ref] is what the core keeps as a stage's `os_ref`
 * and what a deleter later gets back, so its spelling is a contract between
 * three places: the platform that mints it (`IosMediaLibrary`), the walker that
 * stages under it, and the shell that deletes by it (`PhotoLibraryDeleter.swift`,
 * which restates [identifierOf] and [witnessOf] and is held to them by
 * `LibraryDeletionTests`). The core reads only the part before the first `#`
 * (`item_of`, `crates/core/src/phone/mod.rs`): every ref of one asset is one
 * library item, offered for deletion whole or not at all.
 *
 * ```
 *   <identifier>                a plain asset's original (and a v0 build's ref)
 *   <identifier>#pairedVideo    a Live Photo's movie
 *   <identifier>#camera         what the camera wrote under an edit
 *   <identifier>#r<millis>      an edited asset's render, read at that
 *                               `modificationDate`
 * ```
 *
 * `#` cannot occur in a `PHAsset` identifier (`<UUID>/L0/001`).
 */
public object LibraryRefs {
    public const val PAIRED_VIDEO: String = "#pairedVideo"
    public const val CAMERA: String = "#camera"
    private const val RENDITION: String = "#r"

    /** An edited asset's render, read at [modifiedMillis] (A20(3)'s witness). */
    public fun rendition(identifier: String, modifiedMillis: Long): String = "$identifier$RENDITION$modifiedMillis"

    public fun camera(identifier: String): String = identifier + CAMERA

    public fun pairedVideo(identifier: String): String = identifier + PAIRED_VIDEO

    /** The asset a ref names: everything before the first `#`. */
    public fun identifierOf(ref: String): String = ref.substringBefore('#')

    /** The version a rendition's ref was read at, or null for any other ref. */
    public fun witnessOf(ref: String): Long? {
        val at = ref.indexOf(RENDITION)
        if (at < 0) return null
        return ref.substring(at + RENDITION.length).toLongOrNull()
    }

    public fun isCamera(ref: String): Boolean = ref.endsWith(CAMERA)

    public fun isPairedVideo(ref: String): Boolean = ref.endsWith(PAIRED_VIDEO)

    /**
     * WHETHER A CHANGE THE LIBRARY REPORTED IS WORTH OFFERING AGAIN.
     *
     * A newly inserted asset always is. An asset only UPDATED is when the
     * member edited it: a favourite, an album, a hidden flag or a caption bumps
     * the same `modificationDate` and changes no pixel, and an unedited asset's
     * bytes are the camera's, which were backed up as they were. Offering an
     * edited asset whose update turned out to be metadata is deliberate and
     * cheap: the core hashes the rendition, finds it held, adds nothing, and
     * refreshes the version its ref names — which is what lets the deleter
     * release it again (A20(3)).
     */
    public fun worthOffering(insertedSinceToken: Boolean, edited: Boolean): Boolean = insertedSinceToken || edited
}
