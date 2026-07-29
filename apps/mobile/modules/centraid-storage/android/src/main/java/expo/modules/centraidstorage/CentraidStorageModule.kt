package expo.modules.centraidstorage

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class CentraidStorageModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CentraidStorage")

    Function("replicaDirectory") {
      val context = requireNotNull(appContext.reactContext)
      // noBackupFilesDir is credential-encrypted on modern Android and is
      // explicitly excluded from Auto Backup / device-to-device backup.
      File(context.noBackupFilesDir, "CentraidReplica")
        .apply { mkdirs() }
        .absolutePath
    }

    Function("directorySize") { path: String ->
      fun size(file: File): Long =
        if (file.isFile) file.length()
        else file.listFiles()?.sumOf(::size) ?: 0L
      size(File(path)).toDouble()
    }
  }
}
