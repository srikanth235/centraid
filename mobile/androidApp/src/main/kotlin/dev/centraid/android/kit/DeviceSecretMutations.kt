package dev.centraid.android.kit

/** The device value and its listing entry form one synchronous mutation. */
internal class DeviceSecretMutations {
    private val lock = Any()

    fun change(
        key: String,
        present: Boolean,
        writeValue: () -> Boolean,
        readNames: () -> Set<String>,
        writeNames: (Set<String>) -> Boolean,
    ): Boolean = exclusive {
        if (!writeValue()) return@exclusive false
        val names = readNames().toMutableSet()
        if (present) names += key else names -= key
        writeNames(names)
    }

    // Reentrant for listing/adoption's reads; this coordinator never calls a suspending provider.
    fun <T> exclusive(operation: () -> T): T = synchronized(lock) { operation() }
}
