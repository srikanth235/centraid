import Foundation

/// A WIDGET'S TAP ARRIVES AS A URL (#1173, wave 3): `centraid://agenda?open=<key>`.
///
/// The key is the core's, opaque, copied from the snapshot's `open` field into the
/// widget's link (`AgendaGlanceSnapshot.openURL`). The shell reports it as
/// `AgendaIntentOpen` and the core answers with the page to open, or with Agenda's
/// home for a key it did not offer in its last snapshot. **This file names no
/// screen and no destination**, and a URL of any other shape (another scheme or
/// host, a path, other query items) is ignored here, so nothing outside the app
/// can push a route of its choosing.
extension ShellModel {
    /// Report the key a widget's URL carries, or ignore a URL that is not one.
    /// `reportWhenReady` queues the fact until the store has started, which a tap
    /// that launched the app needs.
    func handleOpenURL(_ url: URL) {
        if handleHealthOpenURL(url) { return }
        guard let key = AgendaGlanceSnapshot.openKey(from: url) else { return }
        var open = Centraid_Core_V1_AgendaIntentOpen()
        open.key = key
        var intent = Centraid_Core_V1_AgendaIntent()
        intent.kind = .open(open)
        reportWhenReady(.agendaIntent(intent))
    }
}
