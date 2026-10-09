package dev.centraid.shared.shell

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.newFixedThreadPoolContext

/**
 * THE THREADS THE CORE'S BLOCKING ABI RUNS ON.
 *
 * Every call on the core ABI blocks its thread until it answers, and the core
 * parks a thread for each of three things at once:
 *
 *  - **an event reader per open core** (`CentraidCore.startReader` blocks in
 *    `next_event` for the life of the core, and a vault the member has left
 *    keeps its reader — the queue is bounded and drops nothing);
 *  - **a running `send`**, which holds its thread for the whole of a chat turn
 *    (`ChatDoor.send`);
 *  - **a `cancel`**, which has to be answered WHILE the send is still running
 *    or Stop does nothing until the turn is over.
 *
 * On iOS the core ran on `Dispatchers.Default`, which Kotlin/Native sizes by
 * the core count and which every other coroutine in the app shares: a held
 * vault's reader plus one blocked chat turn was enough to leave no thread for
 * the cancel, and the same pool starved every screen read behind them. So the
 * core gets a pool of its own, sized for the worst case with room to spare:
 * readers for every vault a phone is likely to hold, a send, a cancel, and the
 * ordinary page reads and writes that go through the same door.
 *
 * `newFixedThreadPoolContext` is `@DelicateCoroutinesApi` because the pool is
 * never shut down by the library — which is exactly the wanted lifetime here:
 * one pool for the process, like the core it serves. It exists on Kotlin/Native
 * as well as the JVM (a `MultiWorkerDispatcher`), which is why this can live in
 * `commonMain`. Android's shell keeps `Dispatchers.IO`, whose 64-thread cap is
 * already past this bound.
 */
public object CoreDispatcher {
    /** Readers for four held vaults, a send, a cancel, and headroom for page reads. */
    public const val THREADS: Int = 8

    @OptIn(DelicateCoroutinesApi::class)
    public val dispatcher: CoroutineDispatcher by lazy {
        newFixedThreadPoolContext(THREADS, "centraid-core")
    }
}
