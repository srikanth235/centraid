package dev.centraid.android

import android.app.Application
import dev.centraid.android.backup.BackupNow
import dev.centraid.android.backup.ProcessSession
import dev.centraid.shared.platform.AndroidPlatform
import dev.centraid.shared.platform.SyncPass

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
        val app = this
        // THE PERIODIC WINDOW AND THE EXPEDITED NUDGE (`CentraidSyncWorker`).
        // WorkManager's stop signal is the deadline: a worker gets about ten
        // minutes, so the budget is that minus a margin to finish the part in
        // flight; a pass stopped short resumes next window, because the spool
        // never loses a sealed part.
        SyncPass.install {
            ProcessSession.use(app) { session ->
                ProcessSession.drained(session.drain.run(SyncPass.WORK_MANAGER_BUDGET_MS))
            }
        }
        // "BACK UP NOW" AND A BACKLOG: what `BackgroundTasks.backlog(start)`
        // drives on Android — the user-initiated job, or the `dataSync`
        // foreground service below API 34 (`BackupNow`). Seam contract A11's
        // hook: `HomeSession.backUpNow` starts it with `true` as the member's
        // run begins and stops it with `false` however the run ends, so the
        // job keeps the process alive for exactly that run.
        SyncPass.installBacklog { start ->
            if (start) BackupNow.start(app) else BackupNow.stop(app)
        }
    }
}
