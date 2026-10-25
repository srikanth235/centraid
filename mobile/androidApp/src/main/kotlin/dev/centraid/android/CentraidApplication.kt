package dev.centraid.android

import android.app.Application
import dev.centraid.android.backup.LinkFacts
import dev.centraid.shared.platform.AndroidPlatform

/**
 * ONE CORE PER DEVICE PROCESS, and the one place the context is handed over
 * (#1020, R-1020-24).
 *
 * The `Application` installs the context and the BODIES the OS runs, and
 * nothing else. In particular it does NOT open the core: an `Application.onCreate`
 * that opened one would make every Share, Autofill and Widget process — which
 * share this class — an opener. What it installs opens the process's one
 * session ([ProcessSession]) only when it actually runs, which is in the main
 * process and nowhere else.
 *
 * **The pass the OS runs is installed HERE, not in the activity** (#1080, the
 * shells). It used to be installed when `MainActivity` opened its session, so a
 * periodic window that woke the app with no activity — the whole point of a
 * background window — found nothing installed and reported success over
 * nothing.
 */
public class CentraidApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        AndroidPlatform.install(this)
        // THE PASSES ARE RUST'S (`crates/screens/src/passes`): it asks for the windows
        // (`ScheduleWindows`) and the long run behind "Back up now" (`LongRun`), and
        // `CentraidSyncWorker` reports a granted window to it. The application installs only the
        // context the link reader needs; a worker the OS starts with no Activity opens the
        // process's session itself (`PassHost`), and this opens nothing.
        LinkFacts.screensContext = this
    }
}
