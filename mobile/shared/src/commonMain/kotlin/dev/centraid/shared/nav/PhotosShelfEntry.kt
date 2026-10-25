package dev.centraid.shared.nav

import centraid.core.v1.PhotosPickerPurpose
import centraid.core.v1.PhotosPickerRoute
import centraid.core.v1.PhotosPlacesRoute
import centraid.core.v1.PhotosShelfKind
import centraid.core.v1.PhotosShelfRoute
import centraid.core.v1.Route

/**
 * WHERE THE SHELL ENTERS A PHOTOS SHELF FROM OUTSIDE PHOTOS (#1135): a search
 * hit or a chat card for an album, the places list. Inside Photos a row carries
 * the `Route` Rust built; these are the only routes the shell spells, because
 * the caller holds an id and no row.
 *
 * INTERIM: the shell lane (#1135) replaces the KMP stack with Rust's and deletes
 * this file; a front door then asks Rust for the route.
 */
public object PhotosShelfEntry {
    private const val SHELF: String = "photos.shelf"
    private const val PICKER: String = "photos.picker"
    private const val PLACES: String = "photos.places"

    /** One album's shelf; the name rides along so the head has words before the read lands. */
    public fun album(id: String, name: String = ""): Destination.RustScreen = Destination.RustScreen(
        Route(
            screen = SHELF,
            photos_shelf = PhotosShelfRoute(kind = PhotosShelfKind.PHOTOS_SHELF_KIND_ALBUM, id = id, title = name),
        ),
    )

    /** One place's shelf. */
    public fun place(id: String, name: String = ""): Destination.RustScreen = Destination.RustScreen(
        Route(
            screen = SHELF,
            photos_shelf = PhotosShelfRoute(kind = PhotosShelfKind.PHOTOS_SHELF_KIND_PLACE, id = id, title = name),
        ),
    )

    /** The shelf of the photographs in no place. */
    public fun unplaced(): Destination.RustScreen = Destination.RustScreen(
        Route(
            screen = SHELF,
            photos_shelf = PhotosShelfRoute(kind = PhotosShelfKind.PHOTOS_SHELF_KIND_UNPLACED),
        ),
    )

    /** A standing shelf: favourites, videos, the archive or the trash. */
    public fun standing(kind: PhotosShelfKind): Destination.RustScreen = Destination.RustScreen(
        Route(screen = SHELF, photos_shelf = PhotosShelfRoute(kind = kind)),
    )

    /** The picker that adds photographs to the album [albumId]. */
    public fun picker(albumId: String, albumName: String = ""): Destination.RustScreen = Destination.RustScreen(
        Route(
            screen = PICKER,
            photos_picker = PhotosPickerRoute(
                purpose = PhotosPickerPurpose.PHOTOS_PICKER_PURPOSE_ADD_TO_ALBUM,
                album_id = albumId,
                album_name = albumName,
            ),
        ),
    )

    /** Every place. */
    public fun places(): Destination.RustScreen = Destination.RustScreen(
        Route(screen = PLACES, photos_places = PhotosPlacesRoute()),
    )
}
