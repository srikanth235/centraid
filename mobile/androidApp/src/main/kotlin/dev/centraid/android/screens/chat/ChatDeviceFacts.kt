package dev.centraid.android.screens.chat

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.StatFs
import centraid.core.v1.ChatEvent

/**
 * WHAT THE PHONE IS LIKE FOR THE DOWNLOAD RULES (#1188): the network it is on (Wi-Fi, mobile data,
 * none) and the space it has free. Told to Rust as `ChatEvent.device_facts`, which decides what the
 * download step offers; the downloader reads the same network to hold a transfer to Wi-Fi.
 */
internal object ChatDeviceFacts {
    fun network(context: Context): ChatEvent.DeviceFacts.Network {
        val manager = context.getSystemService(ConnectivityManager::class.java)
            ?: return ChatEvent.DeviceFacts.Network.NETWORK_UNSPECIFIED
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork)
            ?: return ChatEvent.DeviceFacts.Network.NETWORK_OFFLINE
        if (!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
            return ChatEvent.DeviceFacts.Network.NETWORK_OFFLINE
        }
        // Not metered is Wi-Fi (or Ethernet); anything that costs the member data is "mobile data".
        return if (capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)) {
            ChatEvent.DeviceFacts.Network.NETWORK_WIFI
        } else {
            ChatEvent.DeviceFacts.Network.NETWORK_CELLULAR
        }
    }

    /** Bytes free where the model is kept; 0 when the phone cannot say. */
    fun freeBytes(context: Context): Long =
        runCatching { StatFs(context.filesDir.path).availableBytes }.getOrDefault(0L)

    /** The phone's memory, as it reports it; 0 when it cannot say. */
    fun memoryBytes(context: Context): Long = runCatching {
        val info = android.app.ActivityManager.MemoryInfo()
        context.getSystemService(android.app.ActivityManager::class.java).getMemoryInfo(info)
        info.totalMem
    }.getOrDefault(0L)

    fun event(context: Context): ChatEvent = ChatEvent(
        device_facts = ChatEvent.DeviceFacts(
            network = network(context),
            free_bytes = freeBytes(context),
            memory_bytes = memoryBytes(context),
        ),
    )
}
