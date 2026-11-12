import Foundation

/// HEALTH'S WIDGET TAP ARRIVES AS A URL (#1185): `centraid://health?open=<key>`.
///
/// The key is the core's, opaque, copied from the snapshot's `open` field into the
/// widget's link. The shell reports it as `HealthIntent` and the core answers with
/// the page (Health's home for any key). This file names no screen, and a URL of
/// any other shape is ignored.
extension ShellModel {
    /// Report the key a Health widget's URL carries; false for a URL that is not one.
    @discardableResult
    func handleHealthOpenURL(_ url: URL) -> Bool {
        guard let key = HealthGlanceSnapshot.openKey(from: url) else { return false }
        var intent = Centraid_Core_V1_HealthIntent()
        intent.key = key
        reportWhenReady(.healthIntent(intent))
        return true
    }
}
