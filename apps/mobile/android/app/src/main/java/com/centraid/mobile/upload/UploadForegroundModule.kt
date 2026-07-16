package com.centraid.mobile.upload

import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class UploadForegroundModule(private val context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context) {
  override fun getName() = "CentraidUploadForeground"

  @ReactMethod fun start(total: Int) = send(null, 0, total)
  @ReactMethod fun update(completed: Int, total: Int) =
    send(UploadForegroundService.ACTION_UPDATE, completed, total)
  @ReactMethod fun stop() {
    context.stopService(Intent(context, UploadForegroundService::class.java))
  }

  private fun send(action: String?, completed: Int, total: Int) {
    val intent = Intent(context, UploadForegroundService::class.java).apply {
      this.action = action
      putExtra(UploadForegroundService.EXTRA_COMPLETED, completed)
      putExtra(UploadForegroundService.EXTRA_TOTAL, total)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
    else context.startService(intent)
  }
}
