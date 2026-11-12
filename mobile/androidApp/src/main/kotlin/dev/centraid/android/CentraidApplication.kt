package dev.centraid.android

import android.app.Application
import android.content.pm.ApplicationInfo
import android.system.Os
import java.io.File

/**
 * THE APPLICATION OPENS NOTHING (#1020, R-1020-24; #1135).
 *
 * An `Application.onCreate` that opened the core would make every Share, Autofill and Widget
 * process — which share this class — an opener. The process's one session
 * (`session/AppSession.kt`) is opened by whoever first needs it: the activity, or a background
 * window the operating system granted with no activity at all (`backup/PassWork.kt`'s
 * `CentraidSyncWorker`), and the passes themselves are Rust's (`crates/screens/src/passes`).
 */
public class CentraidApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        pointTheChatAtItsDebugScript()
    }

    /**
     * THE CHAT'S DEBUG SCRIPT (#1173, #1188): in a debuggable build, a file named
     * `dev-chat-script.json` in the app's files directory is handed to the core as
     * `CENTRAID_DEV_CHAT_SCRIPT`, which makes the chat's model a scripted one so every chat state
     * can be reached on purpose (`maestro/flows/chat-android.yaml`). This sets one variable and
     * opens nothing. A release build is not debuggable so it never looks, and the core's own
     * reading of the variable is compiled out of a release library
     * (`the_dev_script_is_not_in_a_release_build`).
     */
    private fun pointTheChatAtItsDebugScript() {
        val debuggable = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        if (!debuggable) return
        val script = File(filesDir, "dev-chat-script.json")
        if (script.isFile) Os.setenv("CENTRAID_DEV_CHAT_SCRIPT", script.absolutePath, true)
    }
}
