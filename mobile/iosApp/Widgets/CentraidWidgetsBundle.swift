import SwiftUI
import WidgetKit

/// AGENDA'S WIDGETS (#1173, wave 3) AND HEALTH'S (#1185). Read-only: they draw the snapshot the app
/// keeps in the App Group container and nothing else. This extension never opens
/// the vault, never links the Rust core or SwiftProtobuf, and never writes.
@main
struct CentraidWidgetsBundle: WidgetBundle {
    var body: some Widget {
        UpNextWidget()
        RemindersWidget()
        HealthWidget()
    }
}
