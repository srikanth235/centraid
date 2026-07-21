package dev.centraid.mobile.upload

import android.app.NotificationManager
import android.content.Intent
import android.os.Build
import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class UploadForegroundModule(private val context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context) {
  override fun getName() = "CentraidUploadForeground"

  // A plain start: put the service in the foreground with a notification. It
  // does NOT carry ACTION_DRAIN, so the service stays foreground-only — the JS
  // caller is already draining the durable queue itself.
  @ReactMethod fun start(total: Int) = startForegroundService(0, total)

  // Progress ticks refresh the SAME notification id. Once the service is
  // foregrounded (start ran first) the channel exists, so posting through
  // NotificationManager updates the ongoing notification directly instead of
  // re-invoking startForegroundService on every tick (#431 F12).
  @ReactMethod fun update(completed: Int, total: Int) {
    UploadForegroundService.ensureChannel(context)
    context
      .getSystemService(NotificationManager::class.java)
      .notify(
        UploadForegroundService.NOTIFICATION_ID,
        UploadForegroundService.notification(context, completed, total),
      )
  }

  @ReactMethod fun stop() {
    context.stopService(Intent(context, UploadForegroundService::class.java))
  }

  private fun startForegroundService(completed: Int, total: Int) {
    val intent = Intent(context, UploadForegroundService::class.java).apply {
      putExtra(UploadForegroundService.EXTRA_COMPLETED, completed)
      putExtra(UploadForegroundService.EXTRA_TOTAL, total)
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    } catch (e: Exception) {
      // Android 12+ throws ForegroundServiceStartNotAllowedException (an
      // IllegalStateException) when a foreground service is started from the
      // background. The queue is durable, so we swallow it and let the drain
      // resume on the next foreground rather than crashing the app (#431 F13).
      Log.w("CentraidUpload", "foreground service start refused; queue drains on next foreground", e)
    }
  }
}
