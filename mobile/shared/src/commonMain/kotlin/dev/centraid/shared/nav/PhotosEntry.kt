package dev.centraid.shared.nav

import centraid.core.v1.PhotosDestination
import centraid.core.v1.PhotosDuplicatesRoute
import centraid.core.v1.PhotosEditorRoute
import centraid.core.v1.PhotosHomeRoute
import centraid.core.v1.PhotosLightboxRoute
import centraid.core.v1.Route

/**
 * WHERE THE SHELL ENTERS PHOTOS FROM OUTSIDE IT (#1135): Home's tile and search,
 * a chat card, the onboarding that brings the camera roll in. Inside Photos a
 * row carries the `Route` Rust built; these are the only routes the shell
 * spells, because the caller holds a word or an app id and no row.
 *
 * INTERIM: the shell lane (#1135) replaces the KMP stack with Rust's and deletes
 * this file; a front door then asks Rust for the route.
 */
public object PhotosEntry {
    private const val HOME: String = "photos.home"
    private const val LIGHTBOX: String = "photos.lightbox"
    private const val EDITOR: String = "photos.editor"
    private const val DUPLICATES: String = "photos.duplicates"

    /** Photos' home, landing on [destination] (the library when unspecified). */
    public fun home(
        destination: PhotosDestination = PhotosDestination.PHOTOS_DESTINATION_LIBRARY,
    ): Destination.RustScreen = Destination.RustScreen(
        Route(screen = HOME).copy(photos_home = PhotosHomeRoute(destination = destination)),
    )

    /** Photos' Search, already on [query] (a chat card or a Home search for photographs). */
    public fun search(query: String): Destination.RustScreen = Destination.RustScreen(
        Route(screen = HOME).copy(
            photos_home = PhotosHomeRoute(
                destination = PhotosDestination.PHOTOS_DESTINATION_SEARCH,
                query = query,
            ),
        ),
    )

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
