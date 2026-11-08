import SwiftUI

/// AN APP'S COLOUR, as the three values the design gives it (#1173).
///
/// One hook for every screen that wears an app: `AppAccent("agenda")`. The shell's places
/// (`home`, `chat`, `backup`) and any id this table does not know wear the shell's teal, so a
/// new app is never an unstyled one.
///
/// - `fill` is the colour under white glyphs: the filled `+`, an ink button, a selected state.
///   In dark it is the deeper value, so white on it stays 4.5:1 or more.
/// - `text` is the colour AS text or an icon on the page or a card: a title, a star, a link. It
///   is 4.5:1 on the light page and 6:1 on a dark card; in light it equals `fill`.
/// - `tile` is the bright colour on a tile or an icon where the accent is not that (Notes'
///   yellow). It does not change in dark. For every other app it equals `fill`.
///
/// The values are the generated colour sets (`DesignScale.swift` names, `Assets.xcassets`
/// holds light and dark), so the appearance, including the member's own override, picks the
/// scheme. A literal here would be a colour nobody chose. Stars use `text`, never amber:
/// amber only means a state.
struct AppAccent: Equatable {
    /// The app's id (empty for the shell), for the glyph an empty state draws.
    let appId: String
    let fill: Color
    let text: Color
    let tile: Color
    /// The pale ground of the app's own chip (`TONE_ACCENT`), under `text`. The shell has none and
    /// wears [wash].
    let tint: Color?

    init(_ appId: String) {
        switch appId {
        case "agenda": self.init(appId, CentraidAsset.appAgenda, CentraidAsset.appAgendaText, CentraidAsset.appAgendaTile, CentraidAsset.appAgendaTint)
        case "docs": self.init(appId, CentraidAsset.appDocs, CentraidAsset.appDocsText, CentraidAsset.appDocsTile, CentraidAsset.appDocsTint)
        case "health": self.init(appId, CentraidAsset.appHealth, CentraidAsset.appHealthText, CentraidAsset.appHealthTile, CentraidAsset.appHealthTint)
        case "locker": self.init(appId, CentraidAsset.appLocker, CentraidAsset.appLockerText, CentraidAsset.appLockerTile, CentraidAsset.appLockerTint)
        case "money": self.init(appId, CentraidAsset.appMoney, CentraidAsset.appMoneyText, CentraidAsset.appMoneyTile, CentraidAsset.appMoneyTint)
        case "notes": self.init(appId, CentraidAsset.appNotes, CentraidAsset.appNotesText, CentraidAsset.appNotesTile, CentraidAsset.appNotesTint)
        case "people": self.init(appId, CentraidAsset.appPeople, CentraidAsset.appPeopleText, CentraidAsset.appPeopleTile, CentraidAsset.appPeopleTint)
        case "photos": self.init(appId, CentraidAsset.appPhotos, CentraidAsset.appPhotosText, CentraidAsset.appPhotosTile, CentraidAsset.appPhotosTint)
        default: self.init("", CentraidAsset.shell, CentraidAsset.shellText, CentraidAsset.shell, nil)
        }
    }

    private init(_ appId: String, _ fill: String, _ text: String, _ tile: String, _ tint: String?) {
        self.appId = appId
        self.fill = Color(fill)
        self.text = Color(text)
        self.tile = Color(tile)
        self.tint = tint.map { Color($0) }
    }

    /// The tint behind an app's glyph: the fill at the icon chip's own strength.
    func wash(dark: Bool) -> Color {
        fill.opacity(dark ? CentraidGeometry.iconChipTintDark : CentraidGeometry.iconChipTintLight)
    }

    /// The shell's own colour: Welcome, Home, Chat, Backup.
    static let shell = AppAccent("")
}

private struct AppAccentKey: EnvironmentKey {
    static let defaultValue = AppAccent.shell
}

extension EnvironmentValues {
    /// The accent of the app the view is drawn in. An `AppPlace` states it for its content from
    /// its `app` id, so a row or an empty state inside an app reads its app's colour without
    /// being handed it.
    var appAccent: AppAccent {
        get { self[AppAccentKey.self] }
        set { self[AppAccentKey.self] = newValue }
    }
}

extension View {
    /// Draw this view, and everything in it, in an app's colour.
    func appAccent(_ appId: String) -> some View {
        environment(\.appAccent, AppAccent(appId))
    }
}

/// AN APP'S TILE (#1173): its glyph in white on the app's own solid colour, the way the boards
/// draw a row that names an app (Backup's "In this backup").
struct AppTile: View {
    let appID: String
    var size: CGFloat = 32

    var body: some View {
        if let app = CentraidCatalog.byID[appID] {
            KitTile(iconKey: app.iconKey, size: size, fill: AppAccent(appID).tile)
        }
    }
}
