import SwiftUI

/// An app's colour (#1173), by the app id Rust sends (`ChatCard.app`,
/// `ChatPending.app`): anything shown from another app is drawn in THAT app's
/// colour. The values are the generated colour sets (`CentraidApp<Id>` for the
/// fill, `CentraidApp<Id>Text` for text), so light and dark are the catalogue's;
/// there is no table of colours here. An empty or unknown id is the shell's own
/// teal, which is what a thing that belongs to no app wears.
enum AppAccent {
    /// The app's colour as a fill or a bar (the dark fill in dark).
    static func fill(_ appID: String) -> Color {
        Color(name(appID, text: false))
    }

    /// The app's colour as text or an icon (lighter in dark).
    static func text(_ appID: String) -> Color {
        Color(name(appID, text: true))
    }

    private static func name(_ appID: String, text: Bool) -> String {
        guard known.contains(appID) else {
            return text ? CentraidAsset.shellText : CentraidAsset.shell
        }
        return "CentraidApp" + appID.prefix(1).uppercased() + appID.dropFirst() + (text ? "Text" : "")
    }

    /// The apps that have a colour set. Spelled by the design source's `[app.*]`.
    private static let known: Set<String> = [
        "agenda", "notes", "people", "docs", "money", "locker", "health", "photos",
    ]
}
