package dev.centraid.core

import com.sun.jna.Pointer
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import java.lang.reflect.Proxy
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class JnaLifetimeSpec : StringSpec({
    listOf("centraid_call", "centraid_next_event").forEach { operation ->
        "close waits for $operation and rejects every later handle entry" {
            val entered = CountDownLatch(1)
            val finish = CountDownLatch(1)
            val nativeClosed = CountDownLatch(1)
            val closing = CountDownLatch(1)
            val calls = AtomicInteger()
            val library = Proxy.newProxyInstance(
                CentraidLibrary::class.java.classLoader,
                arrayOf(CentraidLibrary::class.java),
            ) { _, method, _ ->
                when (method.name) {
                    operation -> {
                        calls.incrementAndGet()
                        entered.countDown()
                        check(finish.await(5, TimeUnit.SECONDS))
                        CoreStatus.TIMEOUT.code
                    }
                    "centraid_close" -> {
                        nativeClosed.countDown()
                        CoreStatus.OK.code
                    }
                    else -> error("unexpected native entry: ${method.name}")
                }
            } as CentraidLibrary
            val abi = JnaCentraidAbi(library, Pointer(1))
            val workers = Executors.newFixedThreadPool(2)
            try {
                val read = workers.submit<AbiAnswer> {
                    if (operation == "centraid_call") abi.call(byteArrayOf()) else abi.nextEvent(1)
                }
                entered.await(5, TimeUnit.SECONDS) shouldBe true
                val close = workers.submit<CoreStatus> { closing.countDown(); abi.close() }
                closing.await(5, TimeUnit.SECONDS) shouldBe true
                nativeClosed.await(100, TimeUnit.MILLISECONDS) shouldBe false
                finish.countDown()
                read.get(5, TimeUnit.SECONDS).status shouldBe CoreStatus.TIMEOUT
                close.get(5, TimeUnit.SECONDS) shouldBe CoreStatus.OK
                abi.nextEvent(1).status shouldBe CoreStatus.CLOSED
                abi.call(byteArrayOf()).status shouldBe CoreStatus.CLOSED
                abi.close() shouldBe CoreStatus.CLOSED
                calls.get() shouldBe 1
            } finally {
                finish.countDown()
                workers.shutdownNow()
            }
        }
    }
})
