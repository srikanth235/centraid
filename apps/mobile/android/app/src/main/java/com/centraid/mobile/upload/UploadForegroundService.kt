package com.centraid.mobile.upload

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.jstasks.HeadlessJsTaskConfig

class UploadForegroundService : HeadlessJsTaskService() {
  companion object {
    const val CHANNEL = "centraid-backup"
    const val NOTIFICATION_ID = 419
    const val ACTION_UPDATE = "com.centraid.mobile.upload.UPDATE"
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
  }

  override fun onCreate() {
    super.onCreate()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL, "Photo backup", NotificationManager.IMPORTANCE_LOW)
      )
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val total = intent?.getIntExtra(EXTRA_TOTAL, 1) ?: 1
    val completed = intent?.getIntExtra(EXTRA_COMPLETED, 0) ?: 0
    startForeground(NOTIFICATION_ID, notification(this, completed, total))
    if (intent?.action == ACTION_UPDATE) return START_STICKY
    return super.onStartCommand(intent, flags, startId)
  }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig = HeadlessJsTaskConfig(
    "CentraidUploadDrain", null, 6L * 60L * 60L * 1000L, true
  )
}
