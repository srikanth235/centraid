package dev.centraid.android.kit

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceSecretMutationsTest {
    @Test
    fun competingSetDeleteAndLegacyAdoptionNeverLoseASuccessfullyWrittenName() {
        for (firstKind in listOf("set", "delete", "adopt")) {
            val mutations = DeviceSecretMutations()
            val initial = if (firstKind == "delete") setOf("remove") else emptySet()
            val names = AtomicReference(initial)
            val values = ConcurrentHashMap<String, String>()
            if (firstKind == "delete") values["remove"] = "old public value"
            if (firstKind == "adopt") values["legacy"] = "legacy public value"
            val reads = AtomicInteger()
            val indexWrites = AtomicInteger()
            val firstRead = CountDownLatch(1)
            val releaseFirst = CountDownLatch(1)
            val firstOK = AtomicBoolean()
            val secondOK = AtomicBoolean()
            val readNames = {
                val snapshot = names.get()
                if (reads.incrementAndGet() == 1) {
                    firstRead.countDown()
                    releaseFirst.await()
                }
                snapshot
            }
            val writeNames = { next: Set<String> ->
                indexWrites.incrementAndGet()
                names.set(next)
                true
            }
            val first = Thread {
                firstOK.set(
                    when (firstKind) {
                        "adopt" -> mutations.exclusive {
                            writeNames(readNames() + "legacy")
                        }
                        else -> mutations.change(
                            key = if (firstKind == "delete") "remove" else "first",
                            present = firstKind != "delete",
                            writeValue = {
                                if (firstKind == "delete") values.remove("remove") else values["first"] = "first public value"
                                true
                            },
                            readNames = readNames,
                            writeNames = writeNames,
                        )
                    },
                )
            }
            val second = Thread {
                secondOK.set(mutations.change(
                    key = "second", present = true,
                    writeValue = { values["second"] = "second public value"; true },
                    readNames = readNames, writeNames = writeNames,
                ))
            }
            first.start()
            try {
                firstRead.await()
                second.start()
                // Observe actual contention or completion, never a sleep or elapsed-time budget.
                // Without serialization the second write finishes against the old index;
                // with it the worker blocks until the first complete mutation is released.
                while (second.isAlive && second.state != Thread.State.BLOCKED) Thread.yield()
            } finally {
                releaseFirst.countDown()
                first.join()
                if (second.state != Thread.State.NEW) second.join()
            }
            assertTrue(firstKind, firstOK.get())
            assertTrue(firstKind, secondOK.get())
            assertEquals(firstKind, values.keys.toSet(), names.get())
            assertEquals(2, reads.get())
            assertEquals(2, indexWrites.get())
        }
    }

    @Test
    fun aFailedValueOrIndexCommitIsNeverAcknowledgedAsACompleteMutation() {
        val mutations = DeviceSecretMutations()
        var reads = 0
        var writes = 0
        assertFalse(mutations.change(
            key = "public", present = true,
            writeValue = { false },
            readNames = { reads++; emptySet() },
            writeNames = { writes++; true },
        ))
        assertEquals(0, reads)
        assertEquals(0, writes)

        assertFalse(mutations.change(
            key = "public", present = true,
            writeValue = { true },
            readNames = { emptySet() },
            writeNames = { false },
        ))
        var retryNames: Set<String> = emptySet()
        assertTrue(mutations.change(
            key = "public", present = true,
            writeValue = { true },
            readNames = { retryNames },
            writeNames = { retryNames = it; true },
        ))
        assertEquals(setOf("public"), retryNames)
    }
}
