package dev.centraid.shared.platform

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.os.BatteryManager

/**
 * ANDROID'S BACKGROUND WINDOWS ARE RUST'S NOW (#1135, `crates/screens/src/passes`): the pass
 * scheduler decides which windows exist and under which constraints (`ScheduleWindows`), and the
 * app maps them onto WorkManager (`androidApp/.../backup/PassWork.kt`). What is left of this
 * interface is the member of [PlatformServices] the legacy `HomeSession` still registers through
 * and drives; it schedules nothing, so it cannot undo what Rust scheduled under the same names.
 */
public class AndroidBackgroundTasks : BackgroundTasks {
    override suspend fun register(): BackgroundTasks.Registration =
        BackgroundTasks.Registration(registered = true, sentence = "")

    override fun resubmit() = Unit

    override fun nudge() = Unit

    override fun backlog(start: Boolean) = Unit
}

/**
 * The link and the charger, synchronously (#1080, `DrainRequest`). Null when
 * Android has no active network or no sticky battery broadcast to read: the
 * pass reads null as metered and not charging.
 */
public class AndroidPowerAndLink(private val context: Context) : PowerAndLink {
    override fun metered(): Boolean? {
        val manager = context.getSystemService(ConnectivityManager::class.java) ?: return null
        if (manager.activeNetwork == null) return null
        return manager.isActiveNetworkMetered
    }

    /** External power, from the sticky `ACTION_BATTERY_CHANGED`: plugged counts, full or not. */
    override fun charging(): Boolean? {
        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return null
        val plugged = battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1)
        return if (plugged < 0) null else plugged != 0
    }
}
