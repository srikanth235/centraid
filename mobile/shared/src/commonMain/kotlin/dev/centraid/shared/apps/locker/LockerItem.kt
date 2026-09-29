package dev.centraid.shared.apps.locker

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.LockerItem
import centraid.core.v1.LockerItemRequest
import centraid.core.v1.LockerRevealRefusal
import centraid.screen.v1.Confirm
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.LockerAction
import centraid.screen.v1.LockerClipboard
import centraid.screen.v1.LockerCountdown
import centraid.screen.v1.LockerFieldRow
import centraid.screen.v1.LockerItemChrome
import centraid.screen.v1.LockerItemData
import centraid.screen.v1.LockerItemEvent
import centraid.screen.v1.LockerItemState
import centraid.screen.v1.LockerMemoSheet
import centraid.screen.v1.LockerSection
import centraid.screen.v1.LockerVerb
import centraid.screen.v1.SeatState
import centraid.screen.v1.StatusChip
import centraid.screen.v1.StatusLine
import centraid.screen.v1.WriteSettled
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.LockerCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.WriteLens
import dev.centraid.shared.kit.jsonString
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.Step

/**
 * ONE ITEM (#1047): metadata plainly, and each secret as a sealed row with a
 * verb. **Reveal** asks the core through the gate's door (`LockerAsk`): the
 * receipt is written before the value exists, the value lives on this state
 * for thirty seconds with a countdown, and it is gone on Conceal, on leave and
 * on relock. **Copy** is a reveal whose value goes to the clipboard — local
 * only, sensitive, expiring — and never onto the screen.
 *
 * **A one-time-code seed is never revealed** (Q-1047-16). Its row offers
 * **Show code** and **Copy code**: the core makes the code the seed makes now,
 * receipted first, and the row shows it with its seconds and a countdown. A
 * code that rolls while shown is followed once, so a tap made with two
 * seconds left still leaves a whole code to type; then it conceals.
 */
public object LockerItemMachine :
    LockerQueryMachine<LockerItemState, LockerItemEvent, LockerItemData>("locker.item", LOCKER_TABLES) {
    public const val SCREEN_ID: String = "locker.item"

    /** The product's reveal window (`REVEAL_WINDOW_MS`), in seconds. */
    public const val REVEAL_SECONDS: Int = 30

    /** A copied secret's life on the clipboard. */
    public const val CLIPBOARD_MS: Long = 30_000L

    private const val DOTS: String = "••••••••••"

    override val lens: ContentLens<LockerItemState, LockerItemData> = Lens

    override fun blank(): LockerItemState = LockerItemState(write = WriteState(phase = WriteState.Phase.PHASE_IDLE))

    override fun wiped(held: LockerHeld<LockerItemState>): LockerItemState = lens.with(
        blank().copy(item_id = held.screen.item_id, parent = held.screen.parent),
        ReadContent.Loading(firstLoad = true),
    )

    override fun seatOf(screen: LockerItemState): SeatState = screen.seat ?: SeatState()

    override fun withSeat(screen: LockerItemState, seat: SeatState): LockerItemState = screen.copy(seat = seat)

    override fun view(held: LockerHeld<LockerItemState>, event: LockerItemEvent, entropy: ByteArray): Step<LockerHeld<LockerItemState>> =
        when {
            event.opened != null -> reload(
                LockerHeld(
                    screen = blank().copy(item_id = event.opened.item_id, parent = event.opened.parent, seat = held.screen.seat),
                    open = held.open,
                    tokens = held.tokens,
                ),
            )
            event.refreshed != null -> read(overRows(held))
            event.verb != null -> verb(held, event.verb.key, event.verb.verb)
            event.action != null -> action(held, event.action.key)
            event.confirmed != null -> confirmed(held)
            event.dismissed != null -> Step(held.copy(screen = held.screen.copy(confirm = null)))
            event.status_acted != null -> undo(held)
            event.clipboard_done != null ->
                if (held.screen.clipboard?.token == event.clipboard_done.token) {
                    Step(held.copy(screen = held.screen.copy(clipboard = null)))
                } else {
                    Step(held)
                }
            event.memo_opened != null -> memoOpened(held)
            event.memo_typed != null -> Step(
                held.copy(screen = held.screen.copy(memo = held.screen.memo?.copy(text = event.memo_typed.text))),
            )
            event.memo_saved != null -> memoSaved(held)
            event.memo_closed != null -> Step(held.copy(screen = held.screen.copy(memo = null)))
            // LEAVING CONCEALS: nothing revealed outlives the screen.
            event.left != null -> Step(held.copy(shown = null, asking = null, screen = held.screen.copy(clipboard = null)).refolded())
            // INTENT (edit): the shell pushes the editor.
            else -> Step(held)
        }

    override fun left(): LockerInput<LockerItemEvent> = LockerInput.View(LockerItemEvent(left = LockerItemEvent.Left()))

    // NO ITEM, NO READ: until `Opened` names the item there is nothing to ask
    // the core for, and a read then is refused with "does not know what to
    // read" — a failure flashed before the first open. The gate opening or a
    // row moving before `Opened` leaves the screen loading; `Opened` reads.
    override fun reopened(held: LockerHeld<LockerItemState>): Step<LockerHeld<LockerItemState>> =
        if (held.screen.item_id.isEmpty()) Step(held) else super.reopened(held)

    override fun changed(held: LockerHeld<LockerItemState>): Step<LockerHeld<LockerItemState>> =
        if (held.screen.item_id.isEmpty()) Step(held) else super.changed(held)

    private fun item(held: LockerHeld<LockerItemState>): LockerItem? = held.answers.item?.item

    private fun verb(held: LockerHeld<LockerItemState>, key: String, verb: String): Step<LockerHeld<LockerItemState>> {
        val item = item(held) ?: return Step(held)
        val stored = item.secrets.any { it.column == key && it.present }
        return when {
            verb == "conceal" -> Step(held.copy(shown = null).refolded())
            // A SHOWN CODE COPIES WITHOUT A SECOND RECEIPT, for the reveal's
            // reason, and lives on the clipboard only as long as it is good.
            verb == "copy_code" && stored && held.shown?.code == true && held.shown.column == key -> {
                val token = held.tokens + 1
                Step(
                    held.copy(
                        tokens = token,
                        screen = held.screen.copy(
                            clipboard = LockerClipboard(
                                token = token,
                                value_ = held.shown.value,
                                expires_in_ms = held.shown.secondsLeft * 1_000L,
                                sensitive = true,
                            ),
                            status = StatusLine(sentence = LockerCopy.CODE_COPIED),
                        ),
                    ),
                )
            }
            (verb == "code" || verb == "copy_code") && stored && key == SEED -> {
                if (held.asking != null) return Step(held)
                val token = held.tokens + 1
                val ask = LockerAsk(token, item.item_id, key, copy = verb == "copy_code", code = true, follow = verb == "code")
                Step(held.copy(tokens = token, asking = ask, shown = held.shown?.takeIf { verb == "copy_code" }).refolded())
            }
            // A REVEALED VALUE COPIES WITHOUT A SECOND RECEIPT: it is already
            // revealed, and the receipt already says so.
            verb == "copy" && stored && key != SEED && held.shown?.column == key -> {
                val token = held.tokens + 1
                Step(
                    held.copy(
                        tokens = token,
                        screen = held.screen.copy(
                            clipboard = LockerClipboard(token = token, value_ = held.shown.value, expires_in_ms = CLIPBOARD_MS, sensitive = true),
                            status = StatusLine(sentence = copiedSentence(key)),
                        ),
                    ),
                )
            }
            // THE SEED ITSELF IS NOT SHOWN OR COPIED from this page: its row
            // makes codes, and a reveal of it would be the one secret here
            // that is worth more than what it unlocks today.
            (verb == "reveal" || verb == "copy") && stored && key != SEED -> {
                if (held.asking != null) return Step(held)
                val token = held.tokens + 1
                Step(held.copy(tokens = token, asking = LockerAsk(token, item.item_id, key, copy = verb == "copy")).refolded())
            }
            // A PLAIN VALUE COPIES AS ITSELF — it is metadata, never receipted.
            verb == "copy" -> {
                val value = plainValue(item, key) ?: return Step(held)
                val token = held.tokens + 1
                Step(
                    held.copy(
                        tokens = token,
                        screen = held.screen.copy(
                            clipboard = LockerClipboard(token = token, value_ = value, expires_in_ms = 0L, sensitive = false),
                            status = StatusLine(sentence = LockerFold.fill(LockerCopy.COPIED_PLAIN, "field" to labelOf(key))),
                        ),
                    ),
                )
            }
            else -> Step(held)
        }
    }

    override fun revealed(held: LockerHeld<LockerItemState>, input: LockerInput.Revealed): Step<LockerHeld<LockerItemState>> {
        val ask = held.asking ?: return Step(held)
        val answer = input.answer
        if (ask.code) return coded(held, ask, answer)
        val shown = (answer as? LockerDoorAnswer.Session)?.revealed
        if (shown == null) {
            val sentence = when (answer) {
                is LockerDoorAnswer.Unreachable -> answer.sentence
                is LockerDoorAnswer.Session -> refusalSentence(answer.refusal)
            }
            return Step(held.copy(asking = null, screen = held.screen.copy(status = StatusLine(sentence = sentence, refused = true))).refolded())
        }
        if (ask.copy) {
            val token = held.tokens + 1
            return Step(
                held.copy(
                    asking = null,
                    tokens = token,
                    screen = held.screen.copy(
                        clipboard = LockerClipboard(token = token, value_ = shown.value, expires_in_ms = CLIPBOARD_MS, sensitive = true),
                        status = StatusLine(sentence = copiedSentence(ask.column)),
                    ),
                ).refolded(),
            )
        }
        val seconds = (shown.expiresInMs / 1_000L).toInt().coerceIn(1, REVEAL_SECONDS)
        val next = held.copy(
            asking = null,
            shown = LockerShown(ask.itemId, ask.column, shown.value, ask.token, seconds),
            screen = held.screen.copy(status = null),
        )
        return Step(next.refolded(), listOf(concealTick(ask.token)))
    }

    /** The core answered a code ask: show it with its life, copy it, or say why not. */
    private fun coded(held: LockerHeld<LockerItemState>, ask: LockerAsk, answer: LockerDoorAnswer): Step<LockerHeld<LockerItemState>> {
        val code = (answer as? LockerDoorAnswer.Session)?.code
        if (code == null) {
            val sentence = when (answer) {
                is LockerDoorAnswer.Unreachable -> answer.sentence
                is LockerDoorAnswer.Session -> refusalSentence(answer.refusal)
            }
            return Step(held.copy(asking = null, screen = held.screen.copy(status = StatusLine(sentence = sentence, refused = true))).refolded())
        }
        val seconds = code.remainingSeconds.coerceIn(1, code.periodSeconds.coerceAtLeast(1))
        if (ask.copy) {
            val token = held.tokens + 1
            return Step(
                held.copy(
                    asking = null,
                    tokens = token,
                    screen = held.screen.copy(
                        clipboard = LockerClipboard(token = token, value_ = code.code, expires_in_ms = seconds * 1_000L, sensitive = true),
                        status = StatusLine(sentence = LockerCopy.CODE_COPIED),
                    ),
                ).refolded(),
            )
        }
        val next = held.copy(
            asking = null,
            shown = LockerShown(ask.itemId, ask.column, code.code, ask.token, seconds, code = true, period = code.periodSeconds, follow = ask.follow),
            screen = held.screen.copy(status = null),
        )
        return Step(next.refolded(), listOf(concealTick(ask.token)))
    }

    /**
     * One second of a revealed value's life; at zero it is concealed — or, for
     * a code shown first, the next code is asked for once.
     */
    override fun tick(held: LockerHeld<LockerItemState>, token: String): Step<LockerHeld<LockerItemState>> {
        val shown = held.shown ?: return Step(held)
        if (token != tokenOf(shown.token)) return Step(held)
        val next = shown.ticked()
        return if (next.secondsLeft <= 0 && shown.code && shown.follow && held.asking == null) {
            val ask = held.tokens + 1
            Step(held.copy(shown = null, tokens = ask, asking = LockerAsk(ask, shown.itemId, shown.column, copy = false, code = true, follow = false)).refolded())
        } else if (next.secondsLeft <= 0) {
            Step(held.copy(shown = null).refolded())
        } else {
            Step(held.copy(shown = next).refolded(), listOf(concealTick(shown.token)))
        }
    }

    private fun tokenOf(token: Long): String = "conceal:$token"

    private fun concealTick(token: Long): ScreenEffect =
        ScreenEffect.Schedule(SCREEN_ID, tokenOf(token), delayMs = 1_000L)

    private fun action(held: LockerHeld<LockerItemState>, key: String): Step<LockerHeld<LockerItemState>> {
        val item = item(held) ?: return Step(held)
        val id = item.item_id
        val command = when (key) {
            "star" -> if (item.starred) "locker.unstar_item" else "locker.star_item"
            "archive" -> if (item.archived) "locker.unarchive_item" else "locker.archive_item"
            "trash" -> "locker.trash_item"
            "restore" -> "locker.restore_item"
            "purge" -> return Step(
                held.copy(
                    screen = held.screen.copy(
                        confirm = Confirm(
                            title = LockerCopy.PURGE_TITLE,
                            body = LockerCopy.PURGE_BODY,
                            confirm_label = LockerCopy.PURGE_ACTION,
                            destructive = true,
                        ),
                    ),
                ),
            )
            else -> return Step(held)
        }
        return submit(held, command, "{\"item_id\":${jsonString(id)}}", InvokeKeys.of(command, id, held.tokens.toString()))
    }

    private fun confirmed(held: LockerHeld<LockerItemState>): Step<LockerHeld<LockerItemState>> {
        val item = item(held) ?: return Step(held.copy(screen = held.screen.copy(confirm = null)))
        val cleared = held.copy(screen = held.screen.copy(confirm = null))
        return submit(cleared, "locker.purge_item", "{\"item_id\":${jsonString(item.item_id)}}", InvokeKeys.of("locker.purge_item", item.item_id))
    }

    private fun undo(held: LockerHeld<LockerItemState>): Step<LockerHeld<LockerItemState>> {
        val item = item(held) ?: return Step(held)
        if (held.screen.status?.action_label != LockerCopy.UNDO) return Step(held)
        val cleared = held.copy(screen = held.screen.copy(status = null))
        return submit(
            cleared,
            "locker.restore_item",
            "{\"item_id\":${jsonString(item.item_id)}}",
            InvokeKeys.of("locker.restore_item", item.item_id, held.tokens.toString()),
        )
    }

    private fun submit(held: LockerHeld<LockerItemState>, command: String, input: String, key: String): Step<LockerHeld<LockerItemState>> {
        val step = WriteLaw.submit(Writes, held.screen, command, input, key)
        return Step(held.copy(screen = step.state, tokens = held.tokens + 1), step.effects)
    }

    override fun settled(held: LockerHeld<LockerItemState>, settled: WriteSettled): Step<LockerHeld<LockerItemState>> {
        val submitted = held.screen.write?.invoke_key ?: ""
        val step = WriteLaw.settled(Writes, held.screen, settled)
        var screen = step.state
        if (settled.invoke_key == submitted) {
            screen = when {
                !settled.committed -> screen.copy(
                    status = StatusLine(sentence = settled.failure?.sentence ?: LockerCopy.WRITE_REFUSED, refused = true),
                )
                submitted.startsWith("locker.trash_item") -> screen.copy(status = StatusLine(sentence = LockerCopy.TRASHED, action_label = LockerCopy.UNDO))
                submitted.startsWith("locker.restore_item") -> screen.copy(status = StatusLine(sentence = LockerCopy.RESTORED))
                submitted.startsWith("locker.purge_item") -> screen.copy(status = StatusLine(sentence = LockerCopy.PURGED))
                submitted.startsWith("locker.set_memo") -> screen.copy(memo = null, status = StatusLine(sentence = LockerCopy.MEMO_SAVED))
                else -> screen.copy(status = null)
            }
        }
        return Step(held.copy(screen = screen), step.effects)
    }

    private fun memoOpened(held: LockerHeld<LockerItemState>): Step<LockerHeld<LockerItemState>> {
        val item = item(held) ?: return Step(held)
        if (item.trashed) return Step(held)
        return Step(
            held.copy(
                screen = held.screen.copy(
                    memo = LockerMemoSheet(
                        title = LockerCopy.MEMO_TITLE,
                        text = item.memo,
                        hint = LockerCopy.MEMO_HINT,
                        save_label = LockerCopy.SAVE,
                        cancel_label = LockerCopy.CANCEL,
                    ),
                ),
            ),
        )
    }

    private fun memoSaved(held: LockerHeld<LockerItemState>): Step<LockerHeld<LockerItemState>> {
        val item = item(held) ?: return Step(held)
        val text = held.screen.memo?.text ?: return Step(held)
        if (text.trim() == item.memo.trim()) return Step(held.copy(screen = held.screen.copy(memo = null)))
        return submit(
            held,
            "locker.set_memo",
            "{\"item_id\":${jsonString(item.item_id)},\"note\":${jsonString(text)}}",
            InvokeKeys.of("locker.set_memo", item.item_id, text.hashCode().toString()),
        )
    }

    private fun LockerHeld<LockerItemState>.refolded(): LockerHeld<LockerItemState> {
        if (lens.content(screen) !is ReadContent.Data) return this
        val data = fold(this) ?: return this
        return copy(screen = lens.with(screen, ReadContent.Data(data)))
    }

    // THE ITEM MOVED UNDER A REVEAL (an edit, a trash): the revealed value is
    // for the item as it was, so it goes.
    override fun absorb(held: LockerHeld<LockerItemState>): LockerHeld<LockerItemState> {
        val item = held.answers.item?.item
        val keep = held.shown?.let { shown -> item?.secrets?.any { it.column == shown.column && it.present } == true && !item.trashed }
        return if (keep == true) held else held.copy(shown = null)
    }

    override fun fold(held: LockerHeld<LockerItemState>): LockerItemData? {
        val detail = held.answers.item ?: return null
        val item = detail.item ?: return LockerItemData(gone = EmptyState(headline = LockerCopy.ITEM_GONE, body = LockerCopy.ITEM_GONE_BODY))
        val type = item.type
        val chips = buildList {
            if (item.compromised) add(StatusChip(label = LockerCopy.CHIP_COMPROMISED, tone = StatusChip.Tone.TONE_NET))
            if (item.archived) add(StatusChip(label = LockerCopy.CHIP_ARCHIVED, tone = StatusChip.Tone.TONE_SEAM))
            if (item.trashed) add(StatusChip(label = LockerCopy.CHIP_TRASHED, tone = StatusChip.Tone.TONE_SEAM))
        }
        val sections = buildList {
            add(LockerSection(title = LockerFold.typeLabel(type), rows = own(item, held)))
            if (item.addresses.isNotEmpty()) {
                add(
                    LockerSection(
                        title = LockerCopy.ADDRESSES_HEAD,
                        rows = item.addresses.map {
                            plain("address:${it.address_id}", LockerCopy.ADDRESS, it.url, verbs = openCopy)
                        },
                    ),
                )
            }
            item.fields.groupBy { it.section.ifEmpty { LockerCopy.FIELDS_HEAD } }.forEach { (section, fields) ->
                add(
                    LockerSection(
                        title = section,
                        rows = fields.filter { it.present }.map { field ->
                            if (field.sealed_) {
                                LockerFieldRow(
                                    key = "field:${field.field_id}",
                                    label = field.label,
                                    sealed_ = true,
                                    mask = DOTS,
                                    note = LockerCopy.FIELD_SEALED_NOTE,
                                    accessibility_label = "${field.label}, ${LockerCopy.SEALED}",
                                )
                            } else {
                                plain("field:${field.field_id}", field.label, field.value_)
                            }
                        },
                    ),
                )
            }
            item.passkey?.let { passkey ->
                add(
                    LockerSection(
                        title = LockerCopy.PASSKEY_HEAD,
                        rows = listOfNotNull(
                            plain("passkey:rp", LockerCopy.PASSKEY_SITE, passkey.rp_id),
                            passkey.user_handle.takeIf { it.isNotEmpty() }?.let { plain("passkey:user", LockerCopy.PASSKEY_USER, passkey.display_name.ifEmpty { it }) },
                            LockerFieldRow(
                                key = "passkey:key",
                                label = LockerCopy.PASSKEY_KEY,
                                sealed_ = passkey.has_private_key,
                                mask = if (passkey.has_private_key) DOTS else "",
                                note = LockerCopy.PASSKEY_NOTE,
                            ),
                        ),
                    ),
                )
            }
            add(LockerSection(title = LockerCopy.DETAILS_HEAD, rows = details(item)))
        }.filter { it.rows.isNotEmpty() }
        val actions = if (item.trashed) {
            listOf(
                LockerAction(key = "restore", label = LockerCopy.RESTORE),
                LockerAction(key = "purge", label = LockerCopy.PURGE_ACTION, destructive = true),
            )
        } else {
            listOf(
                LockerAction(key = "star", label = if (item.starred) LockerCopy.UNSTAR else LockerCopy.STAR),
                LockerAction(key = "archive", label = if (item.archived) LockerCopy.UNARCHIVE else LockerCopy.ARCHIVE),
                LockerAction(key = "trash", label = LockerCopy.TRASH, destructive = true),
            )
        }
        return LockerItemData(
            title = item.title,
            type_label = LockerFold.typeLabel(type),
            type_chip = LockerFold.typeChip(type),
            type_key = LockerFold.typeIcon(type),
            starred = item.starred,
            chips = chips,
            status_line = if (item.secrets.any { it.present }) LockerCopy.ITEM_STATUS else "",
            sections = sections,
            tags = item.tags,
            tags_label = if (item.tags.isEmpty()) "" else LockerCopy.TAGS,
            memo = item.memo,
            memo_label = LockerCopy.MEMO_TITLE,
            memo_action = when {
                item.trashed -> ""
                item.memo.isEmpty() -> LockerCopy.MEMO_ADD
                else -> LockerCopy.MEMO_EDIT
            },
            actions = actions,
            trashed_note = if (item.trashed) {
                LockerFold.fill(LockerCopy.TRASHED_NOTE, "day" to item.purge_local_day.takeIf { it.length >= 10 }?.let { CivilWords.dayMonth(it) }.orEmpty())
            } else {
                ""
            },
        )
    }

    /** The type's own fields, in the order a member reads them. */
    private fun own(item: LockerItem, held: LockerHeld<LockerItemState>): List<LockerFieldRow> {
        val columns: List<String> = when (item.type) {
            "login" -> listOf("username", "password", "url", "otp_seed", "notes")
            "card" -> listOf("cardholder", "card_number", "expiry", "cvv", "brand")
            "note" -> listOf("content")
            "identity" -> listOf("fullname", "email", "phone", "address")
            "wifi" -> listOf("network", "password")
            "password" -> listOf("password")
            else -> listOf("notes")
        }
        return columns.mapNotNull { column ->
            val secret = item.secrets.firstOrNull { it.column == column }
            when {
                secret != null && secret.present -> sealedRow(column, held)
                secret != null -> null
                else -> plainValue(item, column)?.takeIf { it.isNotEmpty() }?.let {
                    plain(column, labelOf(column), it, verbs = if (column == "url") openCopy else copyOnly)
                }
            }
        }
    }

    private fun sealedRow(column: String, held: LockerHeld<LockerItemState>): LockerFieldRow {
        if (column == SEED) return codeRow(held)
        val label = labelOf(column)
        val shown = held.shown?.takeIf { it.column == column }
        val asking = held.asking?.takeIf { it.column == column }
        return when {
            shown != null -> LockerFieldRow(
                key = column,
                label = label,
                value_ = shown.value,
                sealed_ = true,
                revealed = true,
                note = LockerFold.fill(LockerCopy.REVEALED_NOTE, "seconds" to shown.secondsLeft.toString()),
                verbs = listOf(LockerVerb(key = "copy", label = LockerCopy.COPY), LockerVerb(key = "conceal", label = LockerCopy.CONCEAL)),
                accessibility_label = "$label, ${LockerCopy.REVEALED}",
                monospace = true,
            )
            asking != null -> LockerFieldRow(
                key = column,
                label = label,
                sealed_ = true,
                mask = DOTS,
                note = LockerCopy.REVEALING,
                accessibility_label = "$label, ${LockerCopy.REVEALING}",
                monospace = true,
            )
            else -> LockerFieldRow(
                key = column,
                label = label,
                sealed_ = true,
                mask = DOTS,
                note = LockerCopy.SEALED_NOTE,
                verbs = listOf(LockerVerb(key = "reveal", label = LockerCopy.REVEAL), LockerVerb(key = "copy", label = LockerCopy.COPY)),
                accessibility_label = "$label, ${LockerCopy.SEALED}",
                monospace = true,
            )
        }
    }

    /** The column whose value is never shown, only the codes it makes. */
    private const val SEED: String = "otp_seed"

    private const val CODE_MASK: String = "••• •••"

    /**
     * A ONE-TIME CODE'S ROW: the code, grouped, with its seconds and a
     * countdown while shown; a mask with Show code and Copy code otherwise.
     */
    private fun codeRow(held: LockerHeld<LockerItemState>): LockerFieldRow {
        val label = labelOf(SEED)
        val shown = held.shown?.takeIf { it.column == SEED && it.code }
        val asking = held.asking?.takeIf { it.column == SEED && !it.copy }
        return when {
            shown != null -> {
                val grouped = if (shown.value.length == 6) "${shown.value.take(3)} ${shown.value.drop(3)}" else shown.value
                LockerFieldRow(
                    key = SEED,
                    label = label,
                    value_ = grouped,
                    sealed_ = true,
                    revealed = true,
                    note = LockerFold.fill(LockerCopy.CODE_NOTE, "seconds" to shown.secondsLeft.toString()),
                    verbs = listOf(LockerVerb(key = "copy_code", label = LockerCopy.COPY), LockerVerb(key = "conceal", label = LockerCopy.CONCEAL)),
                    accessibility_label = "$label, $grouped",
                    monospace = true,
                    countdown = LockerCountdown(seconds_left = shown.secondsLeft, period = shown.period),
                )
            }
            asking != null -> LockerFieldRow(
                key = SEED,
                label = label,
                sealed_ = true,
                mask = CODE_MASK,
                note = LockerCopy.CODE_FETCHING,
                accessibility_label = "$label, ${LockerCopy.CODE_FETCHING}",
                monospace = true,
            )
            else -> LockerFieldRow(
                key = SEED,
                label = label,
                sealed_ = true,
                mask = CODE_MASK,
                note = LockerCopy.OTP_NOTE,
                verbs = listOf(LockerVerb(key = "code", label = LockerCopy.SHOW_CODE), LockerVerb(key = "copy_code", label = LockerCopy.COPY_CODE)),
                accessibility_label = "$label, ${LockerCopy.SEALED}",
                monospace = true,
            )
        }
    }

    private val copyOnly: List<LockerVerb> = listOf(LockerVerb(key = "copy", label = LockerCopy.COPY))

    private val openCopy: List<LockerVerb> = listOf(LockerVerb(key = "open", label = LockerCopy.OPEN), LockerVerb(key = "copy", label = LockerCopy.COPY))

    private fun plain(key: String, label: String, value: String, verbs: List<LockerVerb> = copyOnly): LockerFieldRow =
        LockerFieldRow(key = key, label = label, value_ = value, verbs = verbs, accessibility_label = "$label, $value")

    private fun details(item: LockerItem): List<LockerFieldRow> = listOfNotNull(
        item.alias.takeIf { it.isNotEmpty() }?.let { LockerFieldRow(key = "alias", label = LockerCopy.ALIAS, value_ = it) },
        dayRow("password_set", LockerCopy.PASSWORD_SET, item.password_set_local_day),
        dayRow("created", LockerCopy.CREATED, item.created_local_day),
        dayRow("updated", LockerCopy.UPDATED, item.updated_local_day),
    )

    private fun dayRow(key: String, label: String, day: String): LockerFieldRow? =
        day.takeIf { it.length >= 10 }?.let {
            val words = CivilWords.dayMonth(it)
            LockerFieldRow(key = key, label = label, value_ = words, accessibility_label = "$label, $words")
        }

    internal fun plainValue(item: LockerItem, key: String): String? = when (key) {
        "username" -> item.username
        "url" -> item.url
        "notes" -> item.notes
        "cardholder" -> item.cardholder
        "expiry" -> item.expiry
        "brand" -> item.brand
        "fullname" -> item.fullname
        "email" -> item.email
        "phone" -> item.phone
        "address" -> item.address
        "network" -> item.network
        else -> when {
            key.startsWith("address:") -> item.addresses.firstOrNull { "address:${it.address_id}" == key }?.url
            key.startsWith("field:") -> item.fields.firstOrNull { "field:${it.field_id}" == key && !it.sealed_ }?.value_
            key == "passkey:rp" -> item.passkey?.rp_id
            else -> null
        }
    }

    internal fun labelOf(key: String): String = when (key) {
        "username" -> LockerCopy.FIELD_USERNAME
        "password" -> LockerCopy.FIELD_PASSWORD
        "url" -> LockerCopy.FIELD_URL
        "otp_seed" -> LockerCopy.FIELD_OTP
        "notes" -> LockerCopy.FIELD_NOTES
        "cardholder" -> LockerCopy.FIELD_CARDHOLDER
        "card_number" -> LockerCopy.FIELD_CARD_NUMBER
        "expiry" -> LockerCopy.FIELD_EXPIRY
        "cvv" -> LockerCopy.FIELD_CVV
        "brand" -> LockerCopy.FIELD_BRAND
        "content" -> LockerCopy.FIELD_CONTENT
        "fullname" -> LockerCopy.FIELD_FULLNAME
        "email" -> LockerCopy.FIELD_EMAIL
        "phone" -> LockerCopy.FIELD_PHONE
        "address" -> LockerCopy.FIELD_ADDRESS
        "network" -> LockerCopy.FIELD_NETWORK
        "title" -> LockerCopy.FIELD_TITLE
        else -> LockerCopy.FIELD_VALUE
    }

    private fun copiedSentence(column: String): String = LockerFold.fill(LockerCopy.COPIED_SECRET, "field" to labelOf(column))

    private fun refusalSentence(refusal: LockerRevealRefusal): String = when (refusal) {
        LockerRevealRefusal.LOCKER_REVEAL_REFUSAL_LOCKED -> LockerCopy.REVEAL_LOCKED
        LockerRevealRefusal.LOCKER_REVEAL_REFUSAL_EMPTY -> LockerCopy.REVEAL_EMPTY
        LockerRevealRefusal.LOCKER_REVEAL_REFUSAL_NOT_SEALED -> LockerCopy.REVEAL_GONE
        LockerRevealRefusal.LOCKER_REVEAL_REFUSAL_NOT_A_SEED -> LockerCopy.CODE_NOT_A_SEED
        LockerRevealRefusal.LOCKER_REVEAL_REFUSAL_SEED_NOT_SHOWN -> LockerCopy.REVEAL_SEED
        else -> LockerCopy.REVEAL_DID_NOT_OPEN
    }

    override fun decorate(held: LockerHeld<LockerItemState>): LockerItemState {
        val item = item(held)
        return held.screen.copy(
            chrome = LockerItemChrome(
                title = item?.title ?: "",
                back_label = held.screen.parent.ifEmpty { LockerCopy.APP_NAME },
                edit_label = if (item != null && !item.trashed) LockerCopy.EDIT else "",
                retry = LockerCopy.RETRY,
            ),
        )
    }

    private object Writes : WriteLens<LockerItemState> {
        override fun write(state: LockerItemState): WriteState = state.write ?: WriteState()

        override fun with(state: LockerItemState, write: WriteState): LockerItemState = state.copy(write = write)
    }

    internal object Lens : ContentLens<LockerItemState, LockerItemData> {
        override fun content(state: LockerItemState): ReadContent<LockerItemData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: LockerItemState, content: ReadContent<LockerItemData>): LockerItemState = when (content) {
            is ReadContent.Loading -> state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
            is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
            is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
            is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
        }
    }
}

/** What one item asks. Nothing until it knows which item — or while locked. */
public object LockerItemReads : LockerQueries<LockerItemState, LockerItemEvent>(
    screenId = "locker.item",
    tables = LOCKER_TABLES,
    ask = { held, now ->
        held.screen.item_id.takeIf { it.isNotEmpty() }?.let {
            listOf(AppQueryRequest(locker_item = LockerItemRequest(item_id = it, tz = now.zone)))
        }
    },
)
