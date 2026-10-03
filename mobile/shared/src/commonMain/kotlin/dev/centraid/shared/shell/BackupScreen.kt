package dev.centraid.shared.shell

import centraid.screen.v1.BackupDestinationRow
import centraid.screen.v1.BackupLine
import centraid.screen.v1.BackupRuleChoice
import centraid.screen.v1.BackupScreenEvent
import centraid.screen.v1.BackupScreenState
import centraid.screen.v1.Confirm
import dev.centraid.design.copy.SharedCopy
import dev.centraid.design.copy.WordsCopy
import dev.centraid.shared.custody.CustodyCopy
import dev.centraid.shared.custody.PairDoor
import dev.centraid.shared.custody.PairLaptopMachine
import dev.centraid.shared.custody.PairRefusal
import dev.centraid.shared.custody.PairResult
import dev.centraid.shared.platform.BackgroundTasks
import dev.centraid.shared.sync.BackupLines
import dev.centraid.shared.sync.BackupReading
import dev.centraid.shared.sync.DrainCopy
import dev.centraid.shared.sync.TransferRule
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * `backup.home` — ONE HONEST LINE AND THREE CONTROLS (#1080, the shells).
 *
 * A pure machine: the core's reading and the member's settings in, a finished
 * [BackupScreenState] out, and every act an [BackupEffect] the flow runs. The
 * line at the top is [BackupLines]' and is the same value Home draws. The
 * three controls are the member's transfer rule, "Include videos", and "Back
 * up now"; the destinations are the gateways this vault backs up to, one more
 * added by a pairing payload and one removed only after the member confirms.
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
                    phase = if (model.phase == BackupScreenState.Phase.PHASE_PAIRING) {
                        model.phase
                    } else {
                        BackupScreenState.Phase.PHASE_READY
                    },
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
            is BackupInput.Paired -> step(
                model.copy(phase = BackupScreenState.Phase.PHASE_READY, notice = pairedNotice(input.result)),
                listOf(BackupEffect.Read),
            )
            is BackupInput.Forgot -> step(
                model.copy(
                    notice = if (input.forgotten) {
                        SharedCopy.BACKUP_FORGOTTEN.replace("{name}", input.label)
                    } else {
                        SharedCopy.BACKUP_FORGET_FAILED.replace("{name}", input.label)
                    },
                ),
                listOf(BackupEffect.Read),
            )
        }
    }

    private fun view(model: BackupModel, event: BackupScreenEvent): BackupStep = when {
        event.opened != null -> step(
            model.copy(phase = BackupScreenState.Phase.PHASE_LOADING, notice = "", confirming = null),
            listOf(BackupEffect.Read),
        )
        event.dismissed != null -> step(BackupModel(phase = BackupScreenState.Phase.PHASE_CLOSED))
        event.back_up_now != null && canBackUpNow(model) -> step(
            model.copy(backingUpNow = true, notice = ""),
            listOf(BackupEffect.BackUpNow),
        )
        event.set_rule != null -> {
            val rule = TransferRule.of(event.set_rule.stored)
            step(model.copy(rule = rule, notice = ""), listOf(BackupEffect.WriteRule(rule)))
        }
        event.set_include_videos != null -> {
            val include = event.set_include_videos.include
            step(model.copy(includeVideos = include, notice = ""), listOf(BackupEffect.WriteIncludeVideos(include)))
        }
        event.add_destination != null && model.phase != BackupScreenState.Phase.PHASE_PAIRING -> {
            // THE TEXT AS THE CORE WILL READ IT, by pairing's own rule.
            val ticket = PairLaptopMachine.ticketOf(event.add_destination.payload)
            if (ticket.isEmpty()) {
                step(model.copy(notice = CustodyCopy.PAIR_EMPTY))
            } else {
                step(
                    model.copy(phase = BackupScreenState.Phase.PHASE_PAIRING, notice = ""),
                    listOf(BackupEffect.Pair(ticket)),
                )
            }
        }
        // A FORGET ASKS FIRST, and only for a gateway the screen is drawing.
        event.forget_destination != null &&
            model.destinations().any { it.destinationId == event.forget_destination.destination_id } ->
            step(model.copy(confirming = event.forget_destination.destination_id, notice = ""))
        event.forget_confirmed != null && model.confirming != null -> step(
            model.copy(confirming = null),
            listOf(BackupEffect.Forget(model.confirming, labelOf(model, model.confirming))),
        )
        event.forget_cancelled != null -> step(model.copy(confirming = null))
        else -> BackupStep(model)
    }

    /** Back up now needs a gateway to back up to, a vault that has not moved, and no run already going. */
    private fun canBackUpNow(model: BackupModel): Boolean =
        !model.backingUpNow && model.destinations().isNotEmpty() && !model.line.frozen

    private fun pairedNotice(result: PairResult): String = when (result) {
        is PairResult.Paired -> if (result.answer.safetyNumber.isBlank()) {
            // A PAIRING WITH NOTHING TO COMPARE IS REFUSED (seam contract A7).
            CustodyCopy.PAIR_NOTHING_TO_COMPARE
        } else {
            SharedCopy.BACKUP_PAIRED.replace("{name}", result.answer.laptopName.ifBlank { SharedCopy.BACKUP_UNNAMED })
        }
        is PairResult.Refused -> when (result.because) {
            PairRefusal.UNREACHABLE -> CustodyCopy.PAIR_UNREACHABLE
            PairRefusal.NOT_A_CODE -> WordsCopy.PAIR_NOT_A_CODE
            PairRefusal.NOT_TAKEN -> WordsCopy.PAIR_NOT_TAKEN
        }
    }

    private fun labelOf(model: BackupModel, destinationId: String): String =
        model.destinations().firstOrNull { it.destinationId == destinationId }?.label?.ifBlank { null }
            ?: SharedCopy.BACKUP_UNNAMED

    private fun step(model: BackupModel, effects: List<BackupEffect> = emptyList()): BackupStep =
        BackupStep(render(model), effects)

    internal fun render(model: BackupModel): BackupModel {
        val destinations = model.destinations()
        val spool = model.reading?.spoolBytes ?: 0L
        val choices = buildList {
            add(choice(TransferRule.WIFI_ONLY, SharedCopy.BACKUP_RULE_WIFI, SharedCopy.BACKUP_RULE_WIFI_DETAIL, model.rule))
            add(
                choice(
                    TransferRule.WIFI_AND_CELLULAR_PHOTOS,
                    SharedCopy.BACKUP_RULE_CELLULAR,
                    SharedCopy.BACKUP_RULE_CELLULAR_DETAIL,
                    model.rule,
                ),
            )
            // MANUAL IS DRAWN ONLY WHILE IT IS THE RULE: the screen offers Wi-Fi
            // or cellular, and never hides the choice a member already made.
            if (model.rule == TransferRule.MANUAL) {
                add(choice(TransferRule.MANUAL, SharedCopy.BACKUP_RULE_MANUAL, SharedCopy.BACKUP_RULE_MANUAL_DETAIL, model.rule))
            }
        }
        val confirming = model.confirming
        return model.copy(
            state = BackupScreenState(
                title = SharedCopy.BACKUP_TITLE,
                line = model.line,
                destinations = destinations.map { row(it, model.nowMs) },
                destinations_heading = if (destinations.isEmpty()) "" else SharedCopy.BACKUP_DESTINATIONS,
                add_destination_label = SharedCopy.BACKUP_ADD_DESTINATION,
                rule = model.rule.stored,
                rule_heading = SharedCopy.BACKUP_RULE_HEADING,
                rule_choices = choices,
                include_videos = model.includeVideos,
                include_videos_label = SharedCopy.BACKUP_INCLUDE_VIDEOS,
                include_videos_detail = SharedCopy.BACKUP_INCLUDE_VIDEOS_DETAIL,
                backing_up_now = model.backingUpNow,
                back_up_now_label = if (model.backingUpNow) SharedCopy.BACKUP_NOW_RUNNING else SharedCopy.BACKUP_NOW,
                back_up_now_enabled = canBackUpNow(model),
                last_snapshot_ms = model.reading?.lastSnapshotMs ?: 0L,
                last_ack_ms = model.reading?.lastAckMs ?: 0L,
                spool_bytes = spool,
                spool_label = if (spool > 0L) SharedCopy.BACKUP_SPOOL.replace("{size}", DrainCopy.bytes(spool)) else "",
                notice = model.notice,
                background_notice = model.backgroundNotice,
                confirm = confirming?.let {
                    Confirm(
                        title = SharedCopy.BACKUP_FORGET_TITLE.replace("{name}", labelOf(model, it)),
                        body = SharedCopy.BACKUP_FORGET_BODY,
                        confirm_label = SharedCopy.BACKUP_FORGET_CONFIRM,
                        destructive = true,
                    )
                },
                confirming_destination_id = confirming.orEmpty(),
                phase = model.phase,
            ),
        )
    }

    private fun choice(rule: TransferRule, label: String, detail: String, current: TransferRule) =
        BackupRuleChoice(stored = rule.stored, label = label, detail = detail, selected = rule == current)

    private fun row(destination: dev.centraid.shared.sync.DestinationReading, nowMs: Long): BackupDestinationRow {
        val label = destination.label.ifBlank { SharedCopy.BACKUP_UNNAMED }
        val seen = destination.lastSeenMs?.let { SharedCopy.BACKUP_SEEN.replace("{when}", BackupLines.ago(it, nowMs)) }
            ?: SharedCopy.BACKUP_SEEN_NEVER
        return BackupDestinationRow(
            destination_id = destination.destinationId,
            label = label,
            address = destination.addrs.firstOrNull().orEmpty(),
            seen_label = seen,
            last_seen_ms = destination.lastSeenMs ?: 0L,
            last_ack_ms = destination.lastAckMs ?: 0L,
            forget_label = SharedCopy.BACKUP_FORGET,
            accessibility_label = "$label. $seen",
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
    /** The gateway a pending confirm would forget. */
    public val confirming: String? = null,
    /** This phone's clock when the reading arrived, for "reached 2 minutes ago". */
    public val nowMs: Long = 0,
    public val state: BackupScreenState = BackupScreenState(),
) {
    internal fun destinations() = reading?.destinations.orEmpty()
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

    /** A "Back up now" run started or ended. */
    public data class Running(public val backingUp: Boolean) : BackupInput

    public data class Paired(public val result: PairResult) : BackupInput

    public data class Forgot(public val destinationId: String, public val label: String, public val forgotten: Boolean) : BackupInput
}

public sealed interface BackupEffect {
    /** Re-read the foreground vault, the rule and the registration. */
    public data object Read : BackupEffect

    public data object BackUpNow : BackupEffect

    public data class WriteRule(public val rule: TransferRule) : BackupEffect

    public data class WriteIncludeVideos(public val include: Boolean) : BackupEffect

    public class Pair(internal val ticket: String) : BackupEffect {
        override fun toString(): String = "Pair(<redacted>)"
    }

    public data class Forget(public val destinationId: String, public val label: String) : BackupEffect
}

public data class BackupStep(public val model: BackupModel, public val effects: List<BackupEffect> = emptyList())

/** What the flow needs from the session, as a seam a spec can stand in for. */
public interface BackupScreenDoors {
    /** Re-read the foreground vault's status; null when there is no core. */
    public suspend fun read(): BackupReading?

    /** The line as the store last drew it. */
    public fun line(): BackupLine

    public suspend fun rule(): TransferRule

    public suspend fun includeVideos(): Boolean

    /** The rule and the videos bit were written; the windows follow the rule. */
    public suspend fun writeRule(rule: TransferRule)

    public suspend fun writeIncludeVideos(include: Boolean)

    public fun registration(): BackgroundTasks.Registration?

    public suspend fun backUpNow()

    public val backingUp: StateFlow<Boolean>

    public fun pairDoor(): PairDoor?

    /** True when forgotten, false when the core refused, null when there was no core to ask. */
    public suspend fun forget(destinationId: String): Boolean?

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

    /** Follow "Back up now" runs started anywhere — this screen, a second press, a worker. */
    public fun start() {
        scope.launch { doors.backingUp.collect { reduce(BackupInput.Running(it)) } }
    }

    public fun send(event: BackupScreenEvent) {
        scope.launch { reduce(BackupInput.View(event)) }
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
            // and the screen must go on answering taps while it does.
            scope.launch { run(effect)?.let { reduce(it) } }
        }
    }

    private suspend fun run(effect: BackupEffect): BackupInput? = when (effect) {
        BackupEffect.Read -> {
            val reading = doors.read()
            BackupInput.Read(
                reading = reading,
                line = doors.line(),
                rule = doors.rule(),
                includeVideos = doors.includeVideos(),
                registration = doors.registration(),
                nowMs = doors.nowMs(),
            )
        }
        BackupEffect.BackUpNow -> {
            doors.backUpNow()
            BackupInput.Running(false)
        }
        is BackupEffect.WriteRule -> {
            doors.writeRule(effect.rule)
            null
        }
        is BackupEffect.WriteIncludeVideos -> {
            doors.writeIncludeVideos(effect.include)
            null
        }
        is BackupEffect.Pair -> BackupInput.Paired(
            doors.pairDoor()?.pair(effect.ticket) ?: PairResult.Refused(PairRefusal.UNREACHABLE),
        )
        is BackupEffect.Forget -> BackupInput.Forgot(
            effect.destinationId,
            effect.label,
            forgotten = doors.forget(effect.destinationId) == true,
        )
    }
}
