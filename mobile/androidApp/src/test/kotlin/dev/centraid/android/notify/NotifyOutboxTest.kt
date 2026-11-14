package dev.centraid.android.notify

import android.content.Context
import android.content.SharedPreferences
import centraid.core.v1.NotificationAnswered
import centraid.core.v1.NotificationVerb
import java.lang.reflect.Proxy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class NotifyOutboxTest {
    private fun prefs(name: String): SharedPreferences =
        RuntimeEnvironment.getApplication().getSharedPreferences(name, Context.MODE_PRIVATE)

    @Test
    fun onlyTheExactTerminalTripleRetiresAPress() {
        val store = NotifyOutbox(prefs("notify-exact-ack"))
        val verb = NotificationVerb.NOTIFICATION_VERB_OPEN
        store.add("task|a", verb.value, "press-a")
        store.add("task|a", verb.value, "press-b")
        val answer = NotificationAnswered(notification_id = "task|a", verb = verb, press_id = "press-a")
        store.acknowledge(answer.copy(notification_id = "task|other"))
        store.acknowledge(answer.copy(verb = NotificationVerb.NOTIFICATION_VERB_UNSPECIFIED))
        store.acknowledge(answer.copy(press_id = "unrelated"))
        assertEquals(setOf("press-a", "press-b"), store.pending().map { it.pressId }.toSet())
        store.acknowledge(answer)
        assertEquals(listOf("press-b"), store.pending().map { it.pressId })
        store.acknowledge(answer)
        assertEquals(listOf("press-b"), store.pending().map { it.pressId })
    }

    @Test
    fun failedPersistenceDoesNotAuthorizeBannerDismissalOrDelivery() {
        val underlying = prefs("notify-failed-write")
        val refused = proxy<SharedPreferences>(SharedPreferences::class.java) { method, args ->
            if (method.name == "edit") {
                val editor = underlying.edit()
                lateinit var wrapped: SharedPreferences.Editor
                wrapped = proxy(SharedPreferences.Editor::class.java) { edit, editArgs ->
                    if (edit.name == "commit") false else {
                        val result = edit.invoke(editor, *editArgs)
                        if (result is SharedPreferences.Editor) wrapped else result
                    }
                }
                wrapped
            } else method.invoke(underlying, *args)
        }
        assertNull(NotifyOutbox(refused).add("task|a", 1, "failed"))
        assertEquals(emptyList<NotifyOutbox.Press>(), NotifyOutbox(underlying).pending())
    }

    private fun <T : Any> proxy(type: Class<T>, action: (java.lang.reflect.Method, Array<out Any?>) -> Any?): T =
        checkNotNull(type.cast(Proxy.newProxyInstance(type.classLoader, arrayOf(type)) { _, method, args -> action(method, args.orEmpty()) }))
}
