package dev.centraid.shared.apps.people

import centraid.screen.v1.Confirm
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.PeopleChannelSheet
import centraid.screen.v1.PeopleDateSheet
import centraid.screen.v1.PeopleKindChoice
import centraid.screen.v1.PeopleLogTouchSheet
import centraid.screen.v1.PeopleMergeChoices
import centraid.screen.v1.PeopleMergeSheet
import centraid.screen.v1.PeopleNoteSheet
import centraid.screen.v1.PeoplePersonChrome
import centraid.screen.v1.PeoplePersonData
import centraid.screen.v1.PeoplePersonEvent
import centraid.screen.v1.PeoplePersonSheet
import centraid.screen.v1.PeoplePersonState
import centraid.screen.v1.PeoplePersonState.PendingWrite
import centraid.screen.v1.PeopleSheetFrame
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SeatState
import centraid.screen.v1.WriteSettled
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.PeopleCopy
import dev.centraid.shared.apps.people.PeopleWords.fill
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.WriteLens
import dev.centraid.shared.kit.jsonString
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * ONE PERSON (#1029 app port): the header, nickname and how you met, channels,
 * dates, notes and the touch log, and every write the sheet makes.
 *
 * - **Content pushes, choices sheet** (#1015 D4): Edit is the shell's push to
 *   `people.editor` (an intent); Log a touch, Add note, Add date and Add
 *   channel are write sheets over this screen; Merge is a choices sheet that
 *   picks, from the roster, who folds INTO this person.
 * - **Destroying is asked first**, in full sentences: move to trash, remove a
 *   channel (no undo), merge (cannot be undone).
 * - **One write in flight** ([WriteLaw]). A refused write keeps the sheet and
 *   its fields with the sentence over them; with no sheet, the sentence goes
 *   on the status line. Nothing on screen changes on a guess except the star,
 *   which shows the star asked for until the answer.
 * - A person moved to the trash here sets [PeoplePersonState.done]: the shell
 *   pops. One gone by any other road (merged away, trashed elsewhere) draws
 *   the `gone` state with a way back.
 *
 * Calling, mailing and opening a map are the SHELL's (`ChannelTapped` names the
 * channel; its row carries the intent and the value).
 */
public object PeoplePersonMachine : ScreenMachine<PeoplePersonState, PeoplePersonEvent> {
    public const val SCREEN_ID: String = "people.person"

    public const val LOG_COMMAND: String = "people.log_interaction"
    public const val NOTE_COMMAND: String = "people.add_note"
    public const val DATE_COMMAND: String = "people.add_important_date"
    public const val REMINDER_COMMAND: String = "people.toggle_reminder"
    public const val CHANNEL_SAVE_COMMAND: String = "people.save_contact_channel"
    public const val CHANNEL_REMOVE_COMMAND: String = "people.delete_contact_channel"
    public const val TRASH_COMMAND: String = "people.trash_person"
    public const val MERGE_COMMAND: String = "core.merge_party"

    /** Every command this screen submits, for the spec that checks they exist. */
    public val COMMANDS: List<String> = listOf(
        PeopleHomeMachine.STAR_COMMAND,
        PeopleHomeMachine.UNSTAR_COMMAND,
        LOG_COMMAND,
        NOTE_COMMAND,
        DATE_COMMAND,
        REMINDER_COMMAND,
        CHANNEL_SAVE_COMMAND,
        CHANNEL_REMOVE_COMMAND,
        TRASH_COMMAND,
        MERGE_COMMAND,
    )

    /** Home's tables, and the sheet's own: channels and notes. */
    public val TABLES: Set<String> = PeopleHomeMachine.TABLES + setOf("social_contact_channel", "knowledge_annotation")

    override fun initial(): PeoplePersonState = decorate(
        PeoplePersonState(
            loading = Loading(first_load = true),
            write = WriteState(phase = WriteState.Phase.PHASE_IDLE),
            pending = PendingWrite(kind = PendingWrite.Kind.KIND_NONE),
        ),
    )

    override fun reduce(state: PeoplePersonState, event: PeoplePersonEvent): Step<PeoplePersonState> {
        val step = step(state, event)
        return Step(decorate(step.state), step.effects)
    }

    override fun rowsChanged(table: String, keys: List<String>): PeoplePersonEvent? =
        if (table in TABLES) {
            PeoplePersonEvent(rows_changed = PeoplePersonEvent.RowsChanged(table = table, keys = keys))
        } else {
            null
        }

    override fun seatChanged(seat: SeatState): PeoplePersonEvent =
        PeoplePersonEvent(seat_changed = PeoplePersonEvent.SeatChanged(seat = seat))

    // ---------------------------------------------------------------------

    private fun step(state: PeoplePersonState, event: PeoplePersonEvent): Step<PeoplePersonState> = when {
        event.opened != null -> {
            val opened = PeoplePersonState(
                party_id = event.opened.party_id,
                name_hint = event.opened.name,
                seat = state.seat,
                loading = Loading(first_load = true),
                write = WriteState(phase = WriteState.Phase.PHASE_IDLE),
                pending = PendingWrite(kind = PendingWrite.Kind.KIND_NONE),
                sheet = if (event.opened.log_touch) PeoplePersonSheet(log_touch = logSheet()) else null,
            )
            Step(opened, listOf(read()))
        }
        event.refreshed != null -> Step(state, listOf(read()))
        event.data_ != null -> arrived(state, event.data_)
        event.refused != null -> refused(state, event.refused.failure ?: Reads.refused(""))
        event.denied != null -> Step(
            state.copy(loading = null, failure = null, data_ = null, gone = null, denied = event.denied, sheet = null),
        )
        event.rows_changed != null ->
            if (state.done || state.denied != null || state.party_id.isEmpty()) Step(state) else Step(state, listOf(read()))
        event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))
        event.write_settled != null -> settled(state, event.write_settled)
        event.star != null -> star(state)
        event.sheet_opened != null -> sheetOpened(state, event.sheet_opened.which)
        event.sheet_closed != null -> Step(state.copy(sheet = null, merge_reading = false))
        event.kind_picked != null -> Step(editSheet(state) { sheet -> kindPicked(sheet, event.kind_picked.key) })
        event.text != null -> Step(editSheet(state) { sheet -> textChanged(sheet, event.text.text) })
        event.second_text != null -> Step(editSheet(state) { sheet -> secondTextChanged(sheet, event.second_text.text) })
        event.flag != null -> Step(editSheet(state, ::flagToggled))
        event.submitted != null -> submitted(state)
        event.reminder != null -> reminder(state, event.reminder.date_id)
        event.remove_channel != null -> askRemoveChannel(state, event.remove_channel.channel_id)
        event.merge_picked != null -> askMerge(state, event.merge_picked.party_id)
        event.trash_tapped != null -> askTrash(state)
        event.confirmed != null -> confirmed(state)
        event.dismissed != null -> Step(dismissed(state))
        // INTENTS: EditRequested and ChannelTapped are the shell's to route.
        else -> Step(state)
    }

    private fun read(): ScreenEffect = ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)

    private fun arrived(state: PeoplePersonState, event: PeoplePersonEvent.DataArrived): Step<PeoplePersonState> {
        var next = state
        if (event.absent) {
            next = next.copy(loading = null, failure = null, denied = null, data_ = null, gone = PeopleSheetFold.gone(), sheet = null)
        } else if (event.person != null) {
            val keepStar = state.data_?.takeIf { it.star_pending }
            val person = if (keepStar != null) {
                event.person.copy(starred = keepStar.starred, star_pending = true)
            } else {
                event.person
            }
            next = next.copy(loading = null, failure = null, denied = null, gone = null, data_ = person)
        }
        val merge = event.merge
        val sheet = next.sheet?.merge
        if (merge != null && sheet != null) {
            val others = merge.choices.filter { it.party_id != state.party_id }
            next = next.copy(
                merge_reading = false,
                sheet = PeoplePersonSheet(
                    merge = sheet.copy(
                        loading = null,
                        failure = null,
                        choices = PeopleMergeChoices(
                            choices = others,
                            empty = if (others.isEmpty()) EmptyState(headline = PeopleCopy.EMPTY_MERGE) else null,
                        ),
                    ),
                ),
            )
        }
        return Step(next)
    }

    private fun refused(state: PeoplePersonState, failure: ReadFailure): Step<PeoplePersonState> {
        val merge = state.sheet?.merge
        if (state.merge_reading && merge != null && state.data_ != null) {
            // The choices could not be read: the sheet says so; the person stands.
            return Step(
                state.copy(
                    merge_reading = false,
                    sheet = PeoplePersonSheet(merge = merge.copy(loading = null, choices = null, failure = failure)),
                ),
            )
        }
        return Step(state.copy(loading = null, denied = null, data_ = null, gone = null, failure = failure, merge_reading = false))
    }

    // --- Sheets ----------------------------------------------------------

    private fun sheetOpened(state: PeoplePersonState, which: PeoplePersonEvent.SheetOpened.Which): Step<PeoplePersonState> {
        if (state.data_ == null) return Step(state)
        val sheet = when (which) {
            PeoplePersonEvent.SheetOpened.Which.WHICH_LOG_TOUCH -> PeoplePersonSheet(log_touch = logSheet())
            PeoplePersonEvent.SheetOpened.Which.WHICH_NOTE -> PeoplePersonSheet(
                note = PeopleNoteSheet(frame = frame(PeopleCopy.ADD_NOTE, PeopleCopy.ADD)),
            )
            PeoplePersonEvent.SheetOpened.Which.WHICH_DATE -> PeoplePersonSheet(
                date = PeopleDateSheet(frame = frame(PeopleCopy.ADD_DATE, PeopleCopy.ADD), reminder_on = true),
            )
            PeoplePersonEvent.SheetOpened.Which.WHICH_CHANNEL -> PeoplePersonSheet(
                channel = PeopleChannelSheet(frame = frame(PeopleCopy.ADD_CHANNEL, PeopleCopy.SAVE)),
            )
            PeoplePersonEvent.SheetOpened.Which.WHICH_MERGE -> {
                val opened = PeoplePersonSheet(merge = PeopleMergeSheet(loading = Loading(first_load = true)))
                return Step(state.copy(sheet = opened, merge_reading = true), listOf(read()))
            }
            else -> return Step(state)
        }
        return Step(state.copy(sheet = sheet))
    }

    private fun logSheet(): PeopleLogTouchSheet = PeopleLogTouchSheet(
        frame = frame(PeopleCopy.LOG_TOUCH, PeopleCopy.LOG),
        kinds = PeopleWords.LOG_KINDS.mapIndexed { index, (key, label) ->
            PeopleKindChoice(key = key, label = label, selected = index == 0)
        },
    )

    private fun frame(title: String, submit: String): PeopleSheetFrame =
        PeopleSheetFrame(title = title, submit_label = submit, cancel_label = PeopleCopy.CANCEL)

    /** A field edit clears the last refusal: the member is answering it. */
    private fun editSheet(
        state: PeoplePersonState,
        change: (PeoplePersonSheet) -> PeoplePersonSheet,
    ): PeoplePersonState {
        val sheet = state.sheet ?: return state
        if (frameOf(sheet)?.sending == true) return state
        return state.copy(sheet = withFrame(change(sheet)) { it.copy(failure = null) })
    }

    private fun kindPicked(sheet: PeoplePersonSheet, key: String): PeoplePersonSheet = when {
        sheet.log_touch != null -> sheet.copy(
            log_touch = sheet.log_touch.copy(kinds = sheet.log_touch.kinds.map { it.copy(selected = it.key == key) }),
        )
        sheet.channel != null -> sheet.copy(
            channel = sheet.channel.copy(kinds = sheet.channel.kinds.map { it.copy(selected = it.key == key) }),
        )
        else -> sheet
    }

    private fun textChanged(sheet: PeoplePersonSheet, text: String): PeoplePersonSheet = when {
        sheet.log_touch != null -> sheet.copy(log_touch = sheet.log_touch.copy(note = text))
        sheet.note != null -> sheet.copy(note = sheet.note.copy(text = text))
        sheet.date != null -> sheet.copy(date = sheet.date.copy(label = text))
        sheet.channel != null -> sheet.copy(channel = sheet.channel.copy(value_ = text))
        else -> sheet
    }

    private fun secondTextChanged(sheet: PeoplePersonSheet, text: String): PeoplePersonSheet = when {
        sheet.date != null -> sheet.copy(date = sheet.date.copy(month_day = text.trim()))
        sheet.channel != null -> sheet.copy(channel = sheet.channel.copy(label = text))
        else -> sheet
    }

    private fun flagToggled(sheet: PeoplePersonSheet): PeoplePersonSheet = when {
        sheet.date != null -> sheet.copy(date = sheet.date.copy(reminder_on = !sheet.date.reminder_on))
        sheet.channel != null -> sheet.copy(channel = sheet.channel.copy(preferred = !sheet.channel.preferred))
        else -> sheet
    }

    private fun submitted(state: PeoplePersonState): Step<PeoplePersonState> {
        val sheet = state.sheet ?: return Step(state)
        val data = state.data_ ?: return Step(state)
        if (frameOf(sheet)?.submit_enabled != true) return Step(state)
        val party = jsonString(state.party_id)
        return when {
            sheet.log_touch != null -> {
                val kind = sheet.log_touch.kinds.firstOrNull { it.selected }?.key ?: return Step(state)
                val note = sheet.log_touch.note.trim()
                val input = buildString {
                    append("{\"party_id\":").append(party).append(",\"kind\":").append(jsonString(kind))
                    if (note.isNotEmpty()) append(",\"text\":").append(jsonString(note))
                    append('}')
                }
                // ONE LOG PER SHEET: the key names what is on screen, so a
                // double tap dedups and the next log is a new command.
                val key = InvokeKeys.of(LOG_COMMAND, state.party_id, kind, note, "after=${data.touches.size}")
                write(state, LOG_COMMAND, input, key, PendingWrite.Kind.KIND_LOG_TOUCH, PeopleWords.touchKind(kind))
            }
            sheet.note != null -> {
                val text = sheet.note.text.trim()
                val input = "{\"party_id\":$party,\"text\":${jsonString(text)}}"
                val key = InvokeKeys.of(NOTE_COMMAND, state.party_id, text, "after=${data.notes.size}")
                write(state, NOTE_COMMAND, input, key, PendingWrite.Kind.KIND_NOTE, data.name)
            }
            sheet.date != null -> {
                val date = sheet.date
                val input = "{\"party_id\":$party,\"label\":${jsonString(date.label.trim())}," +
                    "\"month_day\":${jsonString(date.month_day)},\"reminder_on\":${date.reminder_on}}"
                val key = InvokeKeys.of(DATE_COMMAND, state.party_id, date.label.trim(), date.month_day)
                write(state, DATE_COMMAND, input, key, PendingWrite.Kind.KIND_DATE, data.name)
            }
            sheet.channel != null -> {
                val channel = sheet.channel
                val kind = channel.kinds.firstOrNull { it.selected }?.key ?: return Step(state)
                val label = channel.label.trim()
                val input = buildString {
                    append("{\"party_id\":").append(party)
                    append(",\"kind\":").append(jsonString(kind))
                    append(",\"value\":").append(jsonString(channel.value_.trim()))
                    if (label.isNotEmpty()) append(",\"label\":").append(jsonString(label))
                    append(",\"preferred\":").append(channel.preferred)
                    append('}')
                }
                val key = InvokeKeys.of(CHANNEL_SAVE_COMMAND, state.party_id, kind, channel.value_.trim())
                write(state, CHANNEL_SAVE_COMMAND, input, key, PendingWrite.Kind.KIND_CHANNEL_SAVE, PeopleWords.channelKind(kind))
            }
            else -> Step(state)
        }
    }

    // --- Writes ----------------------------------------------------------

    private fun write(
        state: PeoplePersonState,
        command: String,
        input: String,
        key: String,
        kind: PendingWrite.Kind,
        subject: String,
    ): Step<PeoplePersonState> {
        if (state.write?.phase == WriteState.Phase.PHASE_IN_FLIGHT && state.write.invoke_key != key) {
            // ONE WRITE AT A TIME: the next waits for the answer.
            return Step(state)
        }
        val step = WriteLaw.submit(Writes, state, command, input, key)
        val sheet = state.sheet?.let { withFrame(it) { frame -> frame.copy(sending = true, failure = null) } }
        return Step(
            step.state.copy(pending = PendingWrite(kind = kind, subject = subject), sheet = sheet, status = ""),
            step.effects,
        )
    }

    private fun star(state: PeoplePersonState): Step<PeoplePersonState> {
        val data = state.data_ ?: return Step(state)
        val target = !data.starred
        val command = if (target) PeopleHomeMachine.STAR_COMMAND else PeopleHomeMachine.UNSTAR_COMMAND
        val step = write(
            state,
            command,
            "{\"party_id\":${jsonString(state.party_id)}}",
            InvokeKeys.of(command, state.party_id),
            if (target) PendingWrite.Kind.KIND_STAR else PendingWrite.Kind.KIND_UNSTAR,
            data.name,
        )
        if (step.effects.isEmpty()) return step
        return Step(step.state.copy(data_ = step.state.data_?.copy(starred = target, star_pending = true)), step.effects)
    }

    private fun reminder(state: PeoplePersonState, dateId: String): Step<PeoplePersonState> {
        val date = state.data_?.dates?.firstOrNull { it.date_id == dateId } ?: return Step(state)
        val to = if (date.reminder_on) "off" else "on"
        return write(
            state,
            REMINDER_COMMAND,
            "{\"date_id\":${jsonString(dateId)}}",
            InvokeKeys.of(REMINDER_COMMAND, dateId, to),
            PendingWrite.Kind.KIND_REMINDER,
            date.label,
        ).let { step -> step.copy(state = step.state.copy(pending = step.state.pending?.copy(turns_on = !date.reminder_on))) }
    }

    private fun askTrash(state: PeoplePersonState): Step<PeoplePersonState> {
        val data = state.data_ ?: return Step(state)
        return Step(
            state.copy(
                confirm = Confirm(
                    title = fill(PeopleCopy.CONFIRM_TRASH_TITLE, "name" to data.name),
                    body = PeopleCopy.CONFIRM_TRASH_BODY,
                    confirm_label = PeopleCopy.MOVE_TO_TRASH,
                    destructive = true,
                ),
                trash = true,
                remove_channel_id = null,
                merge_party_id = null,
            ),
        )
    }

    private fun askRemoveChannel(state: PeoplePersonState, channelId: String): Step<PeoplePersonState> {
        val channel = state.data_?.channels?.firstOrNull { it.channel_id == channelId } ?: return Step(state)
        return Step(
            state.copy(
                confirm = Confirm(
                    title = fill(PeopleCopy.CONFIRM_REMOVE_CHANNEL_TITLE, "kind" to channel.kind_label.lowercase()),
                    body = PeopleCopy.CONFIRM_REMOVE_CHANNEL_BODY,
                    confirm_label = PeopleCopy.REMOVE,
                    destructive = true,
                ),
                trash = null,
                remove_channel_id = channelId,
                merge_party_id = null,
            ),
        )
    }

    private fun askMerge(state: PeoplePersonState, partyId: String): Step<PeoplePersonState> {
        val data = state.data_ ?: return Step(state)
        val picked = state.sheet?.merge?.choices?.choices?.firstOrNull { it.party_id == partyId } ?: return Step(state)
        if (partyId == state.party_id) return Step(state)
        return Step(
            state.copy(
                sheet = null,
                confirm = Confirm(
                    title = fill(PeopleCopy.CONFIRM_MERGE_TITLE, "dupe" to picked.name, "keep" to data.name),
                    body = PeopleCopy.CONFIRM_MERGE_BODY,
                    confirm_label = PeopleCopy.MERGE,
                    destructive = true,
                ),
                trash = null,
                remove_channel_id = null,
                merge_party_id = partyId,
                merge_party_name = picked.name,
            ),
        )
    }

    private fun confirmed(state: PeoplePersonState): Step<PeoplePersonState> {
        val data = state.data_ ?: return Step(dismissed(state))
        val cleared = dismissed(state)
        return when {
            state.trash == true -> write(
                cleared,
                TRASH_COMMAND,
                "{\"party_id\":${jsonString(state.party_id)}}",
                InvokeKeys.of(TRASH_COMMAND, state.party_id),
                PendingWrite.Kind.KIND_TRASH,
                data.name,
            )
            state.remove_channel_id != null -> {
                val channel = data.channels.firstOrNull { it.channel_id == state.remove_channel_id }
                write(
                    cleared,
                    CHANNEL_REMOVE_COMMAND,
                    "{\"channel_id\":${jsonString(state.remove_channel_id)}}",
                    InvokeKeys.of(CHANNEL_REMOVE_COMMAND, state.remove_channel_id),
                    PendingWrite.Kind.KIND_CHANNEL_REMOVE,
                    channel?.kind_label ?: "",
                )
            }
            state.merge_party_id != null -> write(
                cleared,
                MERGE_COMMAND,
                // THIS PERSON IS KEPT; the one picked folds into them.
                "{\"survivor_party_id\":${jsonString(state.party_id)},\"merged_party_id\":${jsonString(state.merge_party_id)}}",
                InvokeKeys.of(MERGE_COMMAND, state.party_id, state.merge_party_id),
                PendingWrite.Kind.KIND_MERGE,
                state.merge_party_name,
            )
            else -> Step(cleared)
        }
    }

    private fun dismissed(state: PeoplePersonState): PeoplePersonState =
        state.copy(confirm = null, trash = null, remove_channel_id = null, merge_party_id = null, merge_party_name = "")

    private fun settled(state: PeoplePersonState, settled: WriteSettled): Step<PeoplePersonState> {
        if (settled.invoke_key != state.write?.invoke_key) return Step(state)
        val written = WriteLaw.settled(Writes, state, settled).state
        val pending = state.pending ?: PendingWrite()
        val none = PendingWrite(kind = PendingWrite.Kind.KIND_NONE)
        if (!settled.committed) {
            val sentence = settled.failure ?: Reads.refused(PeopleCopy.WRITE_FAILED)
            val data = written.data_?.let { if (it.star_pending) it.copy(starred = it.vault_starred, star_pending = false) else it }
            val sheet = written.sheet
            return Step(
                if (sheet != null) {
                    written.copy(
                        pending = none,
                        data_ = data,
                        sheet = withFrame(sheet) { it.copy(sending = false, failure = sentence) },
                    )
                } else {
                    written.copy(pending = none, data_ = data, status = sentence.sentence.ifEmpty { PeopleCopy.WRITE_FAILED })
                },
            )
        }
        val name = state.data_?.name ?: ""
        val status = when (pending.kind) {
            PendingWrite.Kind.KIND_STAR -> fill(PeopleCopy.OUTCOME_STARRED, "name" to name)
            PendingWrite.Kind.KIND_UNSTAR -> fill(PeopleCopy.OUTCOME_UNSTARRED, "name" to name)
            PendingWrite.Kind.KIND_LOG_TOUCH -> fill(PeopleCopy.OUTCOME_LOGGED, "kind" to pending.subject, "name" to name)
            PendingWrite.Kind.KIND_NOTE -> fill(PeopleCopy.OUTCOME_NOTED, "name" to name)
            PendingWrite.Kind.KIND_DATE -> fill(PeopleCopy.OUTCOME_DATED, "name" to name)
            PendingWrite.Kind.KIND_REMINDER -> fill(
                if (pending.turns_on) PeopleCopy.OUTCOME_REMINDER_ON else PeopleCopy.OUTCOME_REMINDER_OFF,
                "label" to pending.subject,
            )
            PendingWrite.Kind.KIND_CHANNEL_SAVE -> fill(PeopleCopy.OUTCOME_CHANNEL_SAVED, "kind" to pending.subject)
            PendingWrite.Kind.KIND_CHANNEL_REMOVE -> fill(PeopleCopy.OUTCOME_CHANNEL_REMOVED, "kind" to pending.subject)
            PendingWrite.Kind.KIND_MERGE -> fill(PeopleCopy.OUTCOME_MERGED, "dupe" to pending.subject, "keep" to name)
            PendingWrite.Kind.KIND_TRASH -> fill(PeopleCopy.OUTCOME_TRASHED, "name" to name)
            else -> ""
        }
        return Step(
            written.copy(
                pending = none,
                // A WRITE SHEET CLOSES ON ITS COMMIT; the vault's change event
                // re-reads the sheet, so nothing is added locally on a guess.
                sheet = null,
                status = status,
                done = pending.kind == PendingWrite.Kind.KIND_TRASH,
                data_ = written.data_?.let { if (it.star_pending) it.copy(star_pending = false) else it },
            ),
        )
    }

    // --- Decorate --------------------------------------------------------

    private fun decorate(state: PeoplePersonState): PeoplePersonState = state.copy(
        chrome = CHROME,
        data_ = state.data_?.let { data ->
            data.copy(star_label = if (data.starred) PeopleCopy.UNSTAR_VERB else PeopleCopy.STAR_VERB)
        },
        sheet = state.sheet?.let(::decorateSheet),
    )

    /** Every sheet's words and its submit flag, from its fields. */
    private fun decorateSheet(sheet: PeoplePersonSheet): PeoplePersonSheet = when {
        sheet.log_touch != null -> withFrame(
            sheet.copy(
                log_touch = sheet.log_touch.copy(
                    note_label = PeopleCopy.NOTE_LABEL,
                    note_placeholder = PeopleCopy.NOTE_PLACEHOLDER,
                    hint = PeopleCopy.LOG_HINT,
                ),
            ),
        ) { it.copy(submit_enabled = !it.sending && sheet.log_touch.kinds.any { kind -> kind.selected }) }
        sheet.note != null -> withFrame(
            sheet.copy(note = sheet.note.copy(placeholder = PeopleCopy.NOTE_SHEET_PLACEHOLDER)),
        ) { it.copy(submit_enabled = !it.sending && sheet.note.text.isNotBlank()) }
        sheet.date != null -> {
            val date = sheet.date
            val valid = PeopleWords.validMonthDay(date.month_day)
            withFrame(
                sheet.copy(
                    date = date.copy(
                        label_field = PeopleCopy.DATE_LABEL_FIELD,
                        month_day_field = PeopleCopy.DATE_FIELD,
                        month_day_placeholder = PeopleCopy.DATE_PLACEHOLDER,
                        // SAID ONLY ONCE THERE IS SOMETHING TO BE WRONG ABOUT.
                        month_day_invalid = if (date.month_day.length >= MONTH_DAY_LENGTH && !valid) PeopleCopy.DATE_INVALID else "",
                        reminder_label = PeopleCopy.REMINDER_ON,
                    ),
                ),
            ) { it.copy(submit_enabled = !it.sending && date.label.isNotBlank() && valid) }
        }
        sheet.channel != null -> {
            val channel = sheet.channel
            val kinds = channel.kinds.ifEmpty {
                PeopleWords.CHANNEL_KINDS.mapIndexed { index, (key, label) ->
                    PeopleKindChoice(key = key, label = label, selected = index == 0)
                }
            }
            withFrame(
                sheet.copy(
                    channel = channel.copy(
                        kinds = kinds,
                        value_field = PeopleCopy.CHANNEL_VALUE_FIELD,
                        label_field = PeopleCopy.CHANNEL_LABEL_FIELD,
                        preferred_label = PeopleCopy.CHANNEL_PREFERRED,
                    ),
                ),
            ) { it.copy(submit_enabled = !it.sending && channel.value_.isNotBlank() && kinds.any { k -> k.selected }) }
        }
        sheet.merge != null -> sheet.copy(
            merge = sheet.merge.copy(
                title = PeopleCopy.MERGE_TITLE,
                body = PeopleCopy.MERGE_BODY,
                cancel_label = PeopleCopy.CANCEL,
            ),
        )
        else -> sheet
    }

    private fun frameOf(sheet: PeoplePersonSheet): PeopleSheetFrame? =
        sheet.log_touch?.frame ?: sheet.note?.frame ?: sheet.date?.frame ?: sheet.channel?.frame

    private fun withFrame(sheet: PeoplePersonSheet, change: (PeopleSheetFrame) -> PeopleSheetFrame): PeoplePersonSheet =
        when {
            sheet.log_touch != null ->
                sheet.copy(log_touch = sheet.log_touch.copy(frame = change(sheet.log_touch.frame ?: PeopleSheetFrame())))
            sheet.note != null -> sheet.copy(note = sheet.note.copy(frame = change(sheet.note.frame ?: PeopleSheetFrame())))
            sheet.date != null -> sheet.copy(date = sheet.date.copy(frame = change(sheet.date.frame ?: PeopleSheetFrame())))
            sheet.channel != null ->
                sheet.copy(channel = sheet.channel.copy(frame = change(sheet.channel.frame ?: PeopleSheetFrame())))
            else -> sheet
        }

    private val CHROME = PeoplePersonChrome(
        edit = PeopleCopy.EDIT,
        log_touch = PeopleCopy.LOG_TOUCH,
        add_note = PeopleCopy.ADD_NOTE,
        add_date = PeopleCopy.ADD_DATE,
        add_channel = PeopleCopy.ADD_CHANNEL,
        merge = PeopleCopy.MERGE,
        move_to_trash = PeopleCopy.MOVE_TO_TRASH,
        retry = PeopleCopy.RETRY,
        loading = PeopleCopy.LOADING,
        back = PeopleCopy.APP_TITLE,
    )

    private const val MONTH_DAY_LENGTH: Int = 5

    private object Writes : WriteLens<PeoplePersonState> {
        override fun write(state: PeoplePersonState): WriteState = state.write ?: WriteState()

        override fun with(state: PeoplePersonState, write: WriteState): PeoplePersonState = state.copy(write = write)
    }
}
