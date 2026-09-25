package dev.centraid.shared

import centraid.core.v1.Envelope
import centraid.core.v1.Page
import centraid.core.v1.Response
import centraid.screen.v1.HomeEvent
import centraid.screen.v1.HomeState
import centraid.screen.v1.TileStatus
import centraid.screen.v1.VaultLockup
import dev.centraid.core.CentraidCore
import dev.centraid.shared.platform.FakeDeviceClock
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.HomeMachine
import dev.centraid.shared.shell.HomeReads
import dev.centraid.shared.shell.HomeRuntime
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicReference

/**
 * A VAULT SWITCH MUST RE-POINT HOME'S TILE READS (#1025 live-home).
 *
 * Live proof (iPhone 17 Pro Max sim): pair two vaults, switch A→B→A, Home tiles
 * stay grey LOADING forever while the header says "synced" and Photos on the
 * same vault draws. Forgetting the second vault recovers Home instantly.
 *
 * Photos works because [dev.centraid.shared.sync.ScreenRuntime] takes the core
 * as a supplier and keeps collecting. Home's runner captured the core by value
 * and [dev.centraid.shared.shell.HomeSession] cancelled-and-restarted it on
 * every identity change, racing `publishLockup`'s `ReadPage` against a
 * `SharedFlow` with `replay = 0` — every tile seeded LOADING, nobody serving.
 *
 * Demonstrated red (pre-fix cancel-then-emit-before-collector shape, the
 * same race `rebind` hit when it restarted the runner then `publishLockup`'d):
 * after the switch every readable tile stayed `TILE_STATUS_LOADING` and B was
 * never called — see the characterisation test below.
 */
class HomeSwitchSpec : StringSpec({

    /**
     * Apps Home actually reads; locker has no read and stays seeded. Agenda's
     * app query lands `TileRefused` against a core that answers every request
     * with a page, which is settled — not LOADING — and is what this asks.
     */
    val readable = HomeReads.READ_APP_IDS

    fun emptyPage(): Envelope = Envelope(
        request_id = 0,
        response = Response(page = Page(rows = emptyList())),
    )

    fun core(
        label: String,
        hits: ConcurrentLinkedQueue<String>,
    ): CentraidCore = CentraidCore.answering(Dispatchers.Default) {
        hits.add(label)
        emptyPage()
    }

    suspend fun awaitReadsSettled(host: ScreenHost<HomeState, *>) {
        withTimeout(5_000) {
            host.state.first { state ->
                val tiles = state.data_?.tiles.orEmpty().filter { it.app_id in readable }
                tiles.size == readable.size &&
                    tiles.none { it.status == TileStatus.TILE_STATUS_LOADING }
            }
        }
    }

    suspend fun openNamed(host: ScreenHost<HomeState, HomeEvent>, name: String, id: String) {
        host.send(HomeEvent(opened = HomeEvent.Opened()))
        host.send(
            HomeEvent(
                vault_changed = HomeEvent.VaultChanged(
                    vault = VaultLockup(vault_id = id, vault_name = name),
                ),
            ),
        )
    }

    "switching Home from vault A to B runs tile reads against B, then back against A" {
        // Fixed shape (R-HOME-1, R-HOME-2): one collector for the session, core
        // read at each page through a supplier — matching ScreenRuntime / Photos.
        // Two distinct CentraidCore identities; the supplier moves, the
        // collector does not restart.
        val hits = ConcurrentLinkedQueue<String>()
        val coreA = core("A", hits)
        val coreB = core("B", hits)
        (coreA === coreB) shouldBe false

        val foreground = AtomicReference(coreA)
        val host = ScreenHost(HomeMachine)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val runtime = HomeRuntime(
            core = { foreground.get() },
            host = host,
            scope = scope,
            clock = FakeDeviceClock(),
        ).start()
        delay(50)

        openNamed(host, "Vault A", "vault-a")
        awaitReadsSettled(host)
        hits.toList() shouldContain "A"
        hits.clear()

        foreground.set(coreB)
        host.send(
            HomeEvent(
                vault_changed = HomeEvent.VaultChanged(
                    vault = VaultLockup(vault_id = "vault-b", vault_name = "Vault B"),
                ),
            ),
        )
        awaitReadsSettled(host)
        hits.toList() shouldContain "B"
        host.state.value.data_!!.tiles
            .filter { it.app_id in readable }
            .none { it.status == TileStatus.TILE_STATUS_LOADING } shouldBe true
        hits.clear()

        foreground.set(coreA)
        host.send(
            HomeEvent(
                vault_changed = HomeEvent.VaultChanged(
                    vault = VaultLockup(vault_id = "vault-a", vault_name = "Vault A"),
                ),
            ),
        )
        awaitReadsSettled(host)
        hits.toList() shouldContain "A"

        runtime.cancelAndJoin()
        coreA.close()
        coreB.close()
        scope.coroutineContext[Job]!!.cancel()
    }

    "pre-fix rebind race: ReadPage emitted before the new collector leaves tiles LOADING" {
        // What HomeSession.rebind did on an identity change: cancel the runner,
        // schedule a new HomeRuntime.start() (collect not yet subscribed), then
        // publishLockup → vault_changed → ReadPage into SharedFlow replay=0.
        // A late collector never sees that effect (proved for this buffer shape
        // in the live bug and by SharedFlow's own contract).
        val hits = ConcurrentLinkedQueue<String>()
        val coreA = core("A", hits)
        val coreB = core("B", hits)
        val host = ScreenHost(HomeMachine)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

        var runtime: Job = HomeRuntime({ coreA }, host, scope, FakeDeviceClock()).start()
        delay(50)
        openNamed(host, "Vault A", "vault-a")
        awaitReadsSettled(host)
        hits.clear()

        runtime.cancelAndJoin()
        // Emit the switch BEFORE the replacement collector exists — the race
        // window `start()` then immediate `publishLockup` opens on a loaded
        // Default/IO dispatcher.
        host.send(
            HomeEvent(
                vault_changed = HomeEvent.VaultChanged(
                    vault = VaultLockup(vault_id = "vault-b", vault_name = "Vault B"),
                ),
            ),
        )
        runtime = HomeRuntime({ coreB }, host, scope, FakeDeviceClock()).start()
        delay(500)

        host.state.value.data_!!.tiles
            .filter { it.app_id in readable }
            .all { it.status == TileStatus.TILE_STATUS_LOADING } shouldBe true
        hits.toList() shouldBe emptyList()

        runtime.cancelAndJoin()
        coreA.close()
        coreB.close()
        scope.coroutineContext[Job]!!.cancel()
    }
})
