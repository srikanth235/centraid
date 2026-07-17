package com.centraid.mobile.upload

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.jstasks.HeadlessJsTaskConfig

class UploadForegroundService : HeadlessJsTaskService() {
  companion object {
    const val CHANNEL = "centraid-backup"
    const val NOTIFICATION_ID = 419
    // A live app that is already draining its own queue only needs the service
    // in the foreground with a notification — it must NOT spawn a headless JS
    // task (that would race a second drain against the app's own; see #431 F1).
    const val ACTION_UPDATE = "com.centraid.mobile.upload.UPDATE"
    // The ONLY action that spawns the headless "CentraidUploadDrain" task. It is
    // reserved for lifecycles with no live JS already draining — system service
    // redelivery and any future boot receiver.
    const val ACTION_DRAIN = "com.centraid.mobile.upload.DRAIN"
    const val EXTRA_COMPLETED = "completed"
    const val EXTRA_TOTAL = "total"

    fun notification(context: Context, completed: Int, total: Int) =
      NotificationCompat.Builder(context, CHANNEL)
        .setSmallIcon(com.centraid.mobile.R.mipmap.ic_launcher)
        .setContentTitle("Centraid backup")
        .setContentText("Backing up ${completed.coerceAtMost(total)} of $total")
        .setOnlyAlertOnce(true)
        .setOngoing(true)
        .setProgress(total.coerceAtLeast(1), completed.coerceAtLeast(0), false)
        .build()

    fun ensureChannel(context: Context) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(
          NotificationChannel(CHANNEL, "Photo backup", NotificationManager.IMPORTANCE_LOW)
        )
      }
    }
  }

  override fun onCreate() {
    super.onCreate()
    ensureChannel(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val total = intent?.getIntExtra(EXTRA_TOTAL, 1) ?: 1
    val completed = intent?.getIntExtra(EXTRA_COMPLETED, 0) ?: 0
    startForeground(NOTIFICATION_ID, notification(this, completed, total))
    // Only an explicit drain hands off to HeadlessJsTaskService.onStartCommand,
    // which reads getTaskConfig and starts the JS task. Every other start (a
    // plain start() to raise the notification, or ACTION_UPDATE to refresh it)
    // stays foreground-only and sticky — the app's own JS is already draining.
    return if (intent?.action == ACTION_DRAIN) {
      super.onStartCommand(intent, flags, startId)
    } else {
      START_STICKY
    }
  }

  // Belt-and-braces with onStartCommand: returning null here skips task start
  // (HeadlessJsTaskService only calls startTask when this is non-null), so even
  // a stray super.onStartCommand for a non-drain intent cannot spawn a drain.
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? =
    if (intent?.action == ACTION_DRAIN) {
      HeadlessJsTaskConfig(
        "CentraidUploadDrain", Arguments.createMap(), 6L * 60L * 60L * 1000L, true
      )
    } else {
      null
    }

  // Android 15 (API 35) stops a dataSync FGS at its running-time cap and calls
  // this two-arg overload; the service MUST stop promptly or the platform
  // crashes the app with ForegroundServiceDidNotStopInTimeException. The queue
  // is durable, so stopping here loses nothing — the next foreground/start
  // resumes the drain from disk.
  @RequiresApi(35)
  override fun onTimeout(startId: Int, fgsType: Int) {
    stopSelf()
  }

  // Android 14 (API 34) exposes only the single-arg overload. dataSync uses the
  // two-arg form above, but we honour this one too so no cap can go unhandled.
  @RequiresApi(34)
  override fun onTimeout(startId: Int) {
    stopSelf()
  }
}
