package dev.centraid.shared.nav

/**
 * THE SCREEN IDS A ROUTE IS SPELLED WITH, STATED ONCE.
 *
 * A route that crosses an app's border (a chat card, Home's search, an import's
 * "open") names the screen it opens without importing the machine that owns
 * it: nothing outside `apps` may name an app's types (`PerAppLayoutSpec`), and
 * no app may name another. So the id lives here, in the one package both sides
 * may import, and the machine's own `SCREEN_ID` IS this constant. The SwiftUI
 * shell reads the machine's, never a string.
 *
 * Only the ids [ScreenOpenings] spells are here; a screen no route crosses an
 * app's border to open keeps its id on its machine.
 */
public object ScreenIds {
    /** A screen Rust owns (#1135): the opening's event is the encoded `centraid.core.v1.Route`, whichever app it opens. */
    public const val RUST_SCREEN: String = "rust.screen"



    /** The folder page: the drive's machine on a bridge of its own, keyed apart so the drive under it keeps its tab. */


    public const val PHOTOS_GRID: String = "photos.grid"
    public const val PHOTOS_SHELF: String = "photos.shelf"
    public const val PHOTOS_LIGHTBOX: String = "photos.lightbox"
}
