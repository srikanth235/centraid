import Combine
import Foundation
import SwiftUI

/// What holds the shared module's screen hosts on iOS (#1020, D-1020-E1).
///
/// It is deliberately thin. The screen state machines, the navigation model and
/// the sync scheduler are all in `CentraidShared`; this class exists because
/// SwiftUI needs an `ObservableObject` and Kotlin's `StateFlow` is not one.
///
/// **`call` never runs here.** Every read goes through `CentraidCore`, which
/// asserts it is not on the main thread in both actuals — and this class is a
/// `@MainActor` type, so the assertion is the thing standing between a
/// well-meaning `.task { }` and a frozen app (census §E seam 10).
@MainActor
final class ShellModel: ObservableObject {
    enum Route: Hashable {
        case tally
        case photos
        case note(String)
    }

    @Published var path: [Route] = []
    @Published var masked = false

    /// The last finished state for each screen, as encoded bytes.
    ///
    /// BYTES AND NOT A DECODED MESSAGE, until the view needs one: the shared
    /// module hands over a `ScreenState` whose `state` field is opaque, and a
    /// view decodes only its own. That is what lets one stream carry three
    /// screens without this class knowing about any of them.
    @Published var tallyState = Data()
    @Published var photosState = Data()
    @Published var notesState = Data()

    /// Forward an event. The shared module reduces; nothing here decides.
    func send(screen: String, event: Data) {
        // Wired to `CentraidShared`'s `ScreenHost` on a machine with an Xcode;
        // `mobile/README.md` names this as the first thing the iOS hand-off
        // connects, and it is a `fatalError` rather than a silent no-op so a
        // half-wired build fails on the first tap instead of looking inert.
        fatalError(
            "ShellModel.send is not wired to CentraidShared yet: see " +
            "mobile/README.md -> \"The iOS hand-off\". A no-op here would be a " +
            "screen that renders and never responds."
        )
    }
}
