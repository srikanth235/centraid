package dev.centraid.shared

import dev.centraid.shared.platform.FakeSecureStore
import dev.centraid.shared.platform.JvmSecureRandom
import dev.centraid.shared.platform.SecureStore
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldStartWith

/**
 * The three rules every [SecureStore] keeps, made mechanical (#1025 S5).
 *
 * `SecureStore`'s own comment states two of them in prose and the Keychain and
 * Keystore halves now implement them in two languages' worth of platform C. No
 * machine here can run either — there is no Xcode and no Android SDK — so what
 * is provable on this machine is the LAW, driven against the JVM fake that the
 * state-machine specs already use.
 *
 * That is worth something only because the fake is held to the same rules as
 * the real stores: a fake that stored an empty string, or that answered a key
 * it was never given the prefix for, would let `SyncSchedulerSpec` prove a
 * lock that does not clear and a credential the app wrongly believes it has.
 * This spec is what keeps the fake from being laxer than the thing it fakes.
 */
class SecureStoreLawSpec : StringSpec({

    "an empty write DELETES rather than storing an empty string" {
        // `secure-storage.ts:39-43`, carried into both halves. An empty secret
        // that reads back as PRESENT is a credential the app believes it has,
        // and the seat would present it rather than asking for one.
        val store = FakeSecureStore()
        store.write("seat-token", "opaque")
        store.read("seat-token") shouldBe "opaque"

        store.write("seat-token", "")

        store.read("seat-token").shouldBeNull()
        // Not merely unreadable — GONE. A tombstone that still occupies the key
        // is a row an enumeration would hand back.
        store.keys.shouldBeEmpty()
    }

    "clear() leaves nothing readable, whatever was written before it" {
        // `docs/mobile-offline.md:253`: locking drops every decrypted
        // credential. The lifecycle machine names it as an effect, so it has to
        // be true of the store and not just of the process's own caches.
        val store = FakeSecureStore()
        store.write("seat-token", "opaque")
        store.write("device-key", "material")

        store.clear()

        store.read("seat-token").shouldBeNull()
        store.read("device-key").shouldBeNull()
        store.keys.shouldBeEmpty()
    }

    "every key is namespaced under the v0 prefix" {
        // `SecureStore.PREFIX` is carried over from v0 so a migrating device
        // finds its own secrets, and it is what makes clear() a single scoped
        // delete on both platforms rather than an enumeration: iOS keys the
        // `kSecAttrService` off it, Android the preferences entry name. A store
        // that wrote a bare key would leave that secret behind a clear().
        val store = FakeSecureStore()
        store.write("seat-token", "opaque")
        store.write("device-key", "material")

        store.keys.forEach { it shouldStartWith SecureStore.PREFIX }
        store.keys shouldBe setOf(
            SecureStore.PREFIX + "seat-token",
            SecureStore.PREFIX + "device-key",
        )
    }

    "reading a key that was never written is null, not an empty string" {
        // The same distinction from the other side: absent and empty are one
        // value on this interface, and it is null.
        FakeSecureStore().read("never-written").shouldBeNull()
    }

    "the CSPRNG honours the length exactly and does not repeat itself" {
        // The endpoint secret key is 32 bytes and is what makes a relaunched
        // seat the ENROLLED one, so a short draw is a key with fewer bytes than
        // anything downstream believes, and a repeated draw is one identity on
        // two devices. `kotlin.random.Random` would pass neither claim
        // meaningfully, which is why this is a platform seam.
        val random = JvmSecureRandom()
        random.bytes(32).size shouldBe 32
        random.bytes(0).size shouldBe 0
        random.bytes(32).toList() shouldNotBe random.bytes(32).toList()
    }

    "clear() is counted, because the lifecycle machine asserts it happened" {
        val store = FakeSecureStore()
        store.clear()
        store.clear()
        store.clears shouldBe 2
    }
})
