package expo.modules.centraidnetworkstatus

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CentraidNetworkStatusModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CentraidNetworkStatus")

    AsyncFunction("isNetworkRoaming") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return@AsyncFunction null
      val context = requireNotNull(appContext.reactContext)
      val connectivity =
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val network = connectivity.activeNetwork ?: return@AsyncFunction null
      val capabilities =
        connectivity.getNetworkCapabilities(network) ?: return@AsyncFunction null
      if (!capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
        return@AsyncFunction false
      }
      !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_ROAMING)
    }
  }
}
