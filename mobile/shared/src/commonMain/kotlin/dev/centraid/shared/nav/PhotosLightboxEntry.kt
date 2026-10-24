package dev.centraid.shared.nav

import centraid.core.v1.PhotosDuplicatesRoute
import centraid.core.v1.PhotosEditorRoute
import centraid.core.v1.PhotosLightboxRoute
import centraid.core.v1.Route

/**
 * WHERE THE SHELL ENTERS PHOTOS' ONE-PHOTOGRAPH PAGES FROM OUTSIDE THEM (#1135):
 * Home's search, a chat card, the KMP grids that have not moved yet. Inside the
 * lightbox, the editor and Duplicates a row carries the `Route` Rust built; these
 * are the routes the shell spells because the caller holds an id and no row.
 *
 * INTERIM: the shell lane (#1135) replaces the KMP stack with Rust's and deletes
 * this file; a front door then asks Rust for the route.
 */
public object PhotosLightboxEntry {
    private const val LIGHTBOX: String = "photos.lightbox"
    private const val EDITOR: String = "photos.editor"
    private const val DUPLICATES: String = "photos.duplicates"

    /**
     * One photograph. [neighbours] is the order of the shelf that opened it, so a
     * swipe is a move and never a read; [albumId] is the album it was opened from,
     * empty from anywhere else, so "Make key photo" knows which cover it sets.
     */
    public fun lightbox(
        photoId: String,
        neighbours: List<String> = emptyList(),
        albumId: String = "",
    ): Destination.RustScreen = Destination.RustScreen(
        Route(
            screen = LIGHTBOX,
            photos_lightbox = PhotosLightboxRoute(
                photo_id = photoId,
                neighbour_ids = neighbours,
                album_id = albumId,
            ),
        ),
    )

    /** The editor over one photograph. */
    public fun editor(photoId: String): Destination.RustScreen = Destination.RustScreen(
        Route(screen = EDITOR, photos_editor = PhotosEditorRoute(photo_id = photoId)),
    )

    /** The near-duplicate sets. */
    public fun duplicates(): Destination.RustScreen = Destination.RustScreen(
        Route(screen = DUPLICATES, photos_duplicates = PhotosDuplicatesRoute()),
    )
}
