package dev.centraid.shared.nav

/**
 * THE SCREEN IDS A ROUTE IS SPELLED WITH, STATED ONCE.
 *
 * A route that crosses an app's border (a chat card, Home's search, an import's
 * "open") names the screen it opens without importing the machine that owns
 * it: nothing outside `apps` may name an app's types (`PerAppLayoutSpec`), and
 * no app may name another. So the id lives here, in the one package both sides
 * may import, and the machine's own `SCREEN_ID` IS this constant. The SwiftUI
 * shell reads the machine's (`PeopleHomeMachine.shared.SCREEN_ID`), never a
 * string.
 *
 * Only the ids [ScreenOpenings] spells are here; a screen no route crosses an
 * app's border to open keeps its id on its machine.
 */
public object ScreenIds {
    /** A screen Rust owns (#1135): the opening's event is the encoded `centraid.core.v1.Route`, whichever app it opens. */
    public const val RUST_SCREEN: String = "rust.screen"



    /** The folder page: the drive's machine on a bridge of its own, keyed apart so the drive under it keeps its tab. */

    public const val PEOPLE_HOME: String = "people.home"
    public const val PEOPLE_PERSON: String = "people.person"
    public const val PEOPLE_EDITOR: String = "people.editor"
    public const val PEOPLE_TRASH: String = "people.trash"

    public const val MONEY_HOME: String = "money.home"
    public const val MONEY_TRANSACTION: String = "money.transaction"
    public const val MONEY_TARGET: String = "money.target"
    public const val MONEY_RECURRING: String = "money.recurring"
    public const val MONEY_IMPORT: String = "money.import"
    public const val MONEY_ACCOUNTS: String = "money.accounts"
    public const val MONEY_RULES: String = "money.rules"
    public const val MONEY_CATEGORIES: String = "money.categories"
    public const val MONEY_SEARCH: String = "money.search"

    public const val LOCKER_HOME: String = "locker.home"
    public const val LOCKER_ITEM: String = "locker.item"
    public const val LOCKER_EDITOR: String = "locker.editor"
    public const val LOCKER_TRASH: String = "locker.trash"
    public const val LOCKER_EXPORT: String = "locker.export"
    public const val LOCKER_IMPORT: String = "locker.import"
    public const val LOCKER_ACCESS: String = "locker.access"

    public const val PHOTOS_GRID: String = "photos.grid"
    public const val PHOTOS_SHELF: String = "photos.shelf"
    public const val PHOTOS_LIGHTBOX: String = "photos.lightbox"
}
