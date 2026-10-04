package dev.centraid.shared.sync

import centraid.screen.v1.BackupDestinationRow
import centraid.screen.v1.BackupLine
import centraid.screen.v1.BackupScreenEvent
import centraid.screen.v1.BackupScreenState
import dev.centraid.design.copy.SharedCopy
import dev.centraid.shared.platform.BackgroundTasks
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * `backup.home` — ONE HONEST LINE AND THREE CONTROLS (#1080, the shells; seam
 * contract A11).
 *
 * A pure machine: the core's reading and the member's settings in, a finished
 * [BackupScreenState] out, and every act a [BackupEffect] the flow runs. The
 * line at the top is [BackupLines]' and is the value Home draws. The three
 * controls are the member's transfer rule (the shells draw its choices from
 * `HomeBridge.transferRuleChoices`, one setting with one store), "Include
 * videos", and "Back up now". The destinations are the gateways this vault
 * backs up to; adding one is `pair.laptop`'s, and forgetting one drops only
 * this phone's pairing, so it asks nothing first.
 */
public object BackupScreenMachine {
    public fun initial(): BackupModel = render(BackupModel())

    public fun reduce(model: BackupModel, input: BackupInput): BackupStep {
        if (model.phase == BackupScreenState.Phase.PHASE_CLOSED &&
            !(input is BackupInput.View && input.event.opened != null)
        ) {
            return BackupStep(model)
        }
        return when (input) {
            is BackupInput.View -> view(model, input.event)
            is BackupInput.Read -> step(
                model.copy(
                    phase = BackupScreenState.Phase.PHASE_READY,
                    reading = input.reading,
                    line = input.line,
                    rule = input.rule,
                    includeVideos = input.includeVideos,
                    backgroundNotice = input.registration?.takeIf { !it.registered }?.sentence.orEmpty(),
                    nowMs = input.nowMs,
                ),
            )
            // A RUN THAT ENDED IS RE-READ: what it moved is the line's to say.
            is BackupInput.Running -> step(
                model.copy(backingUpNow = input.backingUp),
                if (model.backingUpNow && !input.backingUp) listOf(BackupEffect.Read) else emptyList(),
            )
            // A RUN THAT IS GOING IS RE-READ AS IT GOES: a pass over a big
            // library runs for minutes, and a count that stood at "0 of 47"
            // while gigabytes reached the gateway was a screen not saying what
            // it knew (#1080, the simulator smoke).
            is BackupInput.Tick -> step(
                model,
                if (model.backingUpNow) listOf(BackupEffect.Read) else emptyList(),
            )
            // A PASS THIS SCREEN DID NOT START IS RE-READ TOO: the walker
            // imports a video while the screen stands open, a pass backs it
            // up, and Home's line moves; a screen that stayed at "All 59"
            // while Home said "All 60" was telling the member the new video
            // was not theirs to count (#1080, the simulator edge cases).
            is BackupInput.Moved -> step(model, listOf(BackupEffect.Read))
            // WHETHER THE GATEWAY WILL REFUSE THIS PHONE NOW is said either
            // way (#1080): a token the gateway was not told about stays live
            // there until its operator revokes it.
            is BackupInput.Forgot -> step(
                model.copy(
                    notice = when {
                        !input.forgotten -> SharedCopy.BACKUP_FORGET_FAILED
                        input.revoked -> SharedCopy.BACKUP_FORGOTTEN_REVOKED
                        else -> SharedCopy.BACKUP_FORGOTTEN_NOT_REVOKED
                    }.replace("{name}", input.label),
                ),
                listOf(BackupEffect.Read),
            )
        }
    }

    private fun view(model: BackupModel, event: BackupScreenEvent): BackupStep = when {
        event.opened != null -> step(
            model.copy(phase = BackupScreenState.Phase.PHASE_LOADING, notice = ""),
            listOf(BackupEffect.Read),
        )
        event.dismissed != null -> step(BackupModel(phase = BackupScreenState.Phase.PHASE_CLOSED))
        event.back_up_now != null && canBackUpNow(model) -> step(
            model.copy(backingUpNow = true, notice = ""),
            listOf(BackupEffect.BackUpNow),
        )
        event.set_include_videos != null -> {
            val include = event.set_include_videos.include
            step(model.copy(includeVideos = include, notice = ""), listOf(BackupEffect.WriteIncludeVideos(include)))
        }
        // ONLY A GATEWAY THE SCREEN IS DRAWING can be forgotten from it.
        event.forget_destination != null &&
            model.destinations().any { it.gatewayId == event.forget_destination.gateway_id } -> {
            val gatewayId = event.forget_destination.gateway_id
            step(model.copy(notice = ""), listOf(BackupEffect.Forget(gatewayId, labelOf(model, gatewayId))))
        }
        else -> BackupStep(model)
    }

    /** Back up now needs a gateway to back up to, a vault that has not moved, and no run already going. */
    private fun canBackUpNow(model: BackupModel): Boolean =
        !model.backingUpNow && model.destinations().isNotEmpty() && !model.line.frozen

    private fun labelOf(model: BackupModel, gatewayId: String): String =
        model.destinations().firstOrNull { it.gatewayId == gatewayId }?.label?.ifBlank { null }
            ?: SharedCopy.BACKUP_UNNAMED

    private fun step(model: BackupModel, effects: List<BackupEffect> = emptyList()): BackupStep =
        BackupStep(render(model), effects)

    internal fun render(model: BackupModel): BackupModel {
        val reading = model.reading
        val stood = backlogStood(reading, model.line.frozen, model.nowMs)
        return model.copy(
            state = BackupScreenState(
                title = SharedCopy.BACKUP_TITLE,
                line = model.line,
                destinations = model.destinations().map { row(it, model.nowMs) },
                add_destination_label = SharedCopy.BACKUP_ADD_DESTINATION,
                forget_label = SharedCopy.BACKUP_FORGET,
                rule = model.rule.stored,
                rule_label = SharedCopy.BACKUP_RULE_HEADING,
                include_videos = model.includeVideos,
                include_videos_label = SharedCopy.BACKUP_INCLUDE_VIDEOS,
                backing_up_now = model.backingUpNow,
                back_up_now_label = SharedCopy.BACKUP_NOW,
                back_up_now_enabled = canBackUpNow(model),
                progress = if (model.backingUpNow) progress(reading) else "",
                battery_sentence = if (stood) SharedCopy.BACKUP_BATTERY else "",
                battery_label = if (stood) SharedCopy.BACKUP_BATTERY_ACTION else "",
                last_snapshot_ms = reading?.lastSnapshotMs ?: 0L,
                last_ack_ms = reading?.lastAckMs ?: 0L,
                spool_bytes = reading?.spoolBytes ?: 0L,
                notice = model.notice,
                background_notice = model.backgroundNotice,
                phase = model.phase,
            ),
        )
    }

    /**
     * A BACKLOG THAT HAS STOOD FOR A DAY: something is still to move and no
     * gateway has acknowledged anything for [BACKLOG_STOOD_MS]. Only then is
     * battery saving worth a sentence; whether it APPLIES is the shell's to
     * read (Android's optimisation list), so the machine never says it is on.
     * A vault never acknowledged is not counted: its first pass runs in the
     * foreground, where battery saving holds nothing back.
     */
    internal fun backlogStood(reading: BackupReading?, frozen: Boolean, nowMs: Long): Boolean {
        if (reading == null || frozen || reading.destinations.isEmpty()) return false
        val acked = reading.lastAckMs ?: return false
        val behind = reading.unconfirmed > 0L || reading.pendingBytes > 0L
        return behind && nowMs - acked >= BACKLOG_STOOD_MS
    }

    /** A day: one night shift missed is ordinary, a whole day without an acknowledgement is not. */
    public const val BACKLOG_STOOD_MS: Long = 24L * 60L * 60L * 1_000L

    /**
     * "Backing up — 1,203 of 1,240 photos and files" while items are still to
     * be acknowledged; plain "Backing up…" when there is nothing to count, or
     * nothing but the records left to send.
     */
    private fun progress(reading: BackupReading?): String =
        if (reading == null || reading.contentTotal <= 0L || reading.unconfirmed == 0L) {
            SharedCopy.BACKUP_NOW_RUNNING
        } else {
            SharedCopy.BACKUP_PROGRESS.replace("{counts}", BackupLines.counts(reading))
        }

    private fun row(destination: DestinationReading, nowMs: Long): BackupDestinationRow {
        val label = destination.label.ifBlank { SharedCopy.BACKUP_UNNAMED }
        val seen = destination.lastSeenMs?.let { SharedCopy.BACKUP_SEEN.replace("{when}", BackupLines.ago(it, nowMs)) }
            ?: SharedCopy.BACKUP_SEEN_NEVER
        val detail = listOfNotNull(destination.addrs.firstOrNull(), seen).joinToString(" · ")
        return BackupDestinationRow(
            gateway_id = destination.gatewayId,
            label = label,
            detail = detail,
            last_seen_ms = destination.lastSeenMs ?: 0L,
            last_ack_ms = destination.lastAckMs ?: 0L,
            accessibility_label = "$label. $detail",
        )
    }
}

/** The machine's model. */
public data class BackupModel(
    public val phase: BackupScreenState.Phase = BackupScreenState.Phase.PHASE_UNSPECIFIED,
    public val reading: BackupReading? = null,
    public val line: BackupLine = BackupLine(),
    public val rule: TransferRule = TransferRule.DEFAULT,
    public val includeVideos: Boolean = true,
    public val backingUpNow: Boolean = false,
    public val notice: String = "",
    public val backgroundNotice: String = "",
    /** This phone's clock when the reading arrived, for "reached 2 minutes ago". */
    public val nowMs: Long = 0,
    public val state: BackupScreenState = BackupScreenState(),
) {
    internal fun destinations(): List<DestinationReading> = reading?.destinations.orEmpty()
}

public sealed interface BackupInput {
    public data class View(public val event: BackupScreenEvent) : BackupInput

    /** What the core, the store and the OS said, read together. */
    public data class Read(
        public val reading: BackupReading?,
        public val line: BackupLine,
        public val rule: TransferRule,
        public val includeVideos: Boolean,
        public val registration: BackgroundTasks.Registration?,
        public val nowMs: Long,
    ) : BackupInput

    /** A "Back up now" run started or ended, wherever it was asked for. */
    public data class Running(public val backingUp: Boolean) : BackupInput

    /** Time passed while a run goes on ([BackupScreenFlow.PROGRESS_READ_MS]). */
    public data object Tick : BackupInput

    /** A pass this screen did not start moved the store's line. */
    public data object Moved : BackupInput

    public data class Forgot(
        public val gatewayId: String,
        public val label: String,
        public val forgotten: Boolean,
        /** The gateway confirmed this phone's token opens nothing there any more. */
        public val revoked: Boolean = false,
    ) : BackupInput
}

public sealed interface BackupEffect {
    /** Re-read the foreground vault, the rule, the videos bit and the registration. */
    public data object Read : BackupEffect

    public data object BackUpNow : BackupEffect

    public data class WriteIncludeVideos(public val include: Boolean) : BackupEffect

    public data class Forget(public val gatewayId: String, public val label: String) : BackupEffect
}

public data class BackupStep(public val model: BackupModel, public val effects: List<BackupEffect> = emptyList())

/** What the flow needs from the session, as a seam a spec can stand in for. */
public interface BackupScreenDoors {
    /** Re-read the foreground vault's status; null when there is no core. */
    public suspend fun read(): BackupReading?

    /** The line as the store draws it, after every pass on this phone. */
    public val line: StateFlow<BackupLine>

    public suspend fun rule(): TransferRule

    public suspend fun includeVideos(): Boolean

    public suspend fun writeIncludeVideos(include: Boolean)

    public fun registration(): BackgroundTasks.Registration?

    public suspend fun backUpNow()

    public val backingUp: StateFlow<Boolean>

    /** What forgetting came to; null when there was no core to ask, or it refused. */
    public suspend fun forget(gatewayId: String): ForgetAnswer?

    public fun nowMs(): Long
}

/** THE MACHINE, RUNNING: effects become door calls, and their answers come back as inputs. */
public class BackupScreenFlow(
    private val doors: BackupScreenDoors,
    private val scope: CoroutineScope,
) {
    private val model = MutableStateFlow(BackupScreenMachine.initial())
    private val lock = Mutex()
    private val published = MutableStateFlow(model.value.state)

    public val state: StateFlow<BackupScreenState> get() = published.asStateFlow()

    /** The model, for specs. */
    public val current: BackupModel get() = model.value

    /**
     * Follow "Back up now" runs started anywhere — this screen, a second press,
     * an Android job — and, while one goes on, re-read every
     * [PROGRESS_READ_MS] so its count moves as the gateway confirms. And follow
     * the store's line, which every pass on this phone moves: the line's first
     * value is the one an open reads anyway, so it is skipped.
     */
    public fun start() {
        scope.launch { doors.backingUp.collect { reduce(BackupInput.Running(it)) } }
        scope.launch { doors.line.drop(1).collect { reduce(BackupInput.Moved) } }
        scope.launch {
            doors.backingUp.collectLatest { running ->
                while (running) {
                    delay(PROGRESS_READ_MS)
                    reduce(BackupInput.Tick)
                }
            }
        }
    }

    public fun send(event: BackupScreenEvent) {
        scope.launch { reduce(BackupInput.View(event)) }
    }

    public companion object {
        /** How often a running "Back up now" is re-read: a status read dials nothing, so it is cheap. */
        public const val PROGRESS_READ_MS: Long = 2_000L
    }

    public suspend fun reduce(input: BackupInput) {
        val effects = lock.withLock {
            val step = BackupScreenMachine.reduce(model.value, input)
            model.value = step.model
            published.value = step.model.state
            step.effects
        }
        effects.forEach { effect ->
            // EACH EFFECT ON ITS OWN COROUTINE: "Back up now" runs for minutes,
            // and the screen goes on answering taps while it does.
            scope.launch { run(effect)?.let { reduce(it) } }
        }
    }

    private suspend fun run(effect: BackupEffect): BackupInput? = when (effect) {
        BackupEffect.Read -> BackupInput.Read(
            reading = doors.read(),
            line = doors.line.value,
            rule = doors.rule(),
            includeVideos = doors.includeVideos(),
            registration = doors.registration(),
            nowMs = doors.nowMs(),
        )
        BackupEffect.BackUpNow -> {
            doors.backUpNow()
            BackupInput.Running(false)
        }
        is BackupEffect.WriteIncludeVideos -> {
            doors.writeIncludeVideos(effect.include)
            null
        }
        is BackupEffect.Forget -> {
            val answer = doors.forget(effect.gatewayId)
            BackupInput.Forgot(
                effect.gatewayId,
                effect.label,
                forgotten = answer?.forgotten == true,
                revoked = answer?.revoked == true,
            )
        }
    }
}
