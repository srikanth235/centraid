package dev.centraid.shared.apps.locker

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.LockerAccessKind
import centraid.core.v1.LockerAccessRequest
import centraid.core.v1.LockerField
import centraid.core.v1.LockerItem
import centraid.core.v1.LockerItemRequest
import centraid.core.v1.LockerRevealRefusal
import centraid.screen.v1.Confirm
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.LockerAction
import centraid.screen.v1.LockerChoice
import centraid.screen.v1.LockerClipboard
import centraid.screen.v1.LockerCountdown
import centraid.screen.v1.LockerFieldRow
import centraid.screen.v1.LockerFieldSheet
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
 *
 * **Custom fields, the passkey and the access history (#1047 T2).** A sealed
 * custom field reveals and copies exactly as the item's own secrets do,
 * through the same door and receipt; a field is added, edited and removed one
 * at a time on the field sheet (`locker.set_field` is one field per command,
 * L-field), and a sealed one's value is sealed by the core on Save. A passkey
 * shows its metadata, is renamed and removed, and its key has no verb at all
 * — the core refuses it too (`KEY_NOT_SHOWN`). The access history is the
 * receipts the vault already wrote about this item, as metadata.
 */
public object LockerItemMachine :
    LockerQueryMachine<LockerItemState, LockerItemEvent, LockerItemData>("locker.item", LOCKER_ITEM_TABLES) {
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
            event.field_typed != null -> Step(fieldTyped(held, event.field_typed.key, event.field_typed.value_))
            event.field_kind != null -> Step(fieldKind(held, event.field_kind.key))
            event.field_saved != null -> fieldSaved(held, entropy)
            event.field_removed != null -> fieldRemoved(held)
            event.field_closed != null -> Step(held.copy(editing = null, screen = held.screen.copy(field_sheet = null)))
            event.passkey_name_typed != null -> Step(
                held.copy(screen = held.screen.copy(passkey_name = held.screen.passkey_name?.copy(text = event.passkey_name_typed.text))),
            )
            event.passkey_name_saved != null -> passkeyNameSaved(held)
            event.passkey_name_closed != null -> Step(held.copy(screen = held.screen.copy(passkey_name = null)))
            // LEAVING CONCEALS: nothing revealed outlives the screen, and a
            // sheet with a typed secret goes with it.
            event.left != null -> Step(
                held.copy(
                    shown = null,
                    asking = null,
                    editing = null,
                    confirming = null,
                    screen = held.screen.copy(clipboard = null, field_sheet = null, passkey_name = null, confirm = null),
                ).refolded(),
            )
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
        val stored = storedSecret(item, key)
        return when {
            verb == "edit" && key.startsWith(FIELD) && !item.trashed -> Step(openField(held, item, key.removePrefix(FIELD)))
            verb == "rename" && key == "passkey:name" && item.passkey != null && !item.trashed -> Step(
                held.copy(
                    screen = held.screen.copy(
                        passkey_name = LockerMemoSheet(
                            title = LockerCopy.PASSKEY_RENAME_TITLE,
                            text = item.passkey?.display_name.orEmpty(),
                            hint = LockerCopy.PASSKEY_RENAME_HINT,
                            save_label = LockerCopy.SAVE,
                            cancel_label = LockerCopy.CANCEL,
                        ),
                    ),
                ),
            )
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
                            status = StatusLine(sentence = copiedSentence(held, key)),
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
                val fieldId = if (key.startsWith(FIELD)) key.removePrefix(FIELD) else ""
                Step(held.copy(tokens = token, asking = LockerAsk(token, item.item_id, key, copy = verb == "copy", fieldId = fieldId)).refolded())
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
                        status = StatusLine(sentence = copiedSentence(held, ask.column)),
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
            "add_field" -> return if (item.trashed) Step(held) else Step(openField(held, item, ""))
            "remove_passkey" -> return if (item.passkey == null) {
                Step(held)
            } else {
                Step(
                    held.copy(
                        confirming = CONFIRM_PASSKEY,
                        screen = held.screen.copy(
                            confirm = Confirm(
                                title = LockerCopy.PASSKEY_REMOVE_TITLE,
                                body = LockerCopy.PASSKEY_REMOVE_BODY,
                                confirm_label = LockerCopy.PASSKEY_REMOVE,
                                destructive = true,
                            ),
                        ),
                    ),
                )
            }
            "purge" -> return Step(
                held.copy(
                    confirming = null,
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
        val item = item(held) ?: return Step(held.copy(confirming = null, screen = held.screen.copy(confirm = null)))
        val cleared = held.copy(confirming = null, screen = held.screen.copy(confirm = null))
        val id = jsonString(item.item_id)
        return when (held.confirming) {
            CONFIRM_FIELD -> {
                val fieldId = held.editing?.takeIf { it.isNotEmpty() } ?: return Step(cleared)
                submit(
                    cleared,
                    "locker.remove_field",
                    "{\"item_id\":$id,\"field_id\":${jsonString(fieldId)}}",
                    InvokeKeys.of("locker.remove_field", item.item_id, fieldId),
                )
            }
            CONFIRM_PASSKEY -> submit(
                cleared,
                "locker.clear_passkey",
                "{\"item_id\":$id}",
                InvokeKeys.of("locker.clear_passkey", item.item_id, held.tokens.toString()),
            )
            else -> submit(cleared, "locker.purge_item", "{\"item_id\":$id}", InvokeKeys.of("locker.purge_item", item.item_id))
        }
    }

    // --- the field sheet (#1047 T2) -------------------------------------------

    private const val FIELD: String = "field:"
    private const val CONFIRM_FIELD: String = "field"
    private const val CONFIRM_PASSKEY: String = "passkey"
    private const val KIND_TEXT: String = "text"
    private const val KIND_SEALED: String = "sealed"

    /** The item's field [fieldId], or a new one when empty. */
    private fun openField(held: LockerHeld<LockerItemState>, item: LockerItem, fieldId: String): LockerHeld<LockerItemState> {
        val field = item.fields.firstOrNull { it.field_id == fieldId }
        if (fieldId.isNotEmpty() && field == null) return held
        val kind = field?.kind ?: KIND_TEXT
        val sheet = LockerFieldSheet(
            section = field?.section.orEmpty(),
            label = field?.label.orEmpty(),
            value_ = if (field != null && !field.sealed_) field.value_ else "",
        )
        return held.copy(editing = fieldId, screen = held.screen.copy(field_sheet = worded(sheet, field, kind)))
    }

    /** Every word the sheet says, for what is typed into it. */
    private fun worded(sheet: LockerFieldSheet, field: LockerField?, kind: String): LockerFieldSheet {
        val sealed = kind == KIND_SEALED
        val label = sheet.label.trim()
        return sheet.copy(
            title = if (field == null) LockerCopy.FIELD_NEW_TITLE else LockerCopy.FIELD_EDIT_TITLE,
            section_label = LockerCopy.FIELD_SECTION,
            section_hint = LockerCopy.FIELD_SECTION_HINT,
            label_label = LockerCopy.FIELD_LABEL,
            label_hint = LockerCopy.FIELD_LABEL_HINT,
            kind_label = if (field == null) LockerCopy.KIND else "",
            kinds = if (field == null) {
                listOf(
                    LockerChoice(key = KIND_TEXT, label = LockerCopy.FIELD_KIND_TEXT, selected = !sealed),
                    LockerChoice(key = KIND_SEALED, label = LockerCopy.FIELD_KIND_SEALED, selected = sealed),
                )
            } else {
                emptyList()
            },
            value_label = LockerCopy.FIELD_VALUE,
            value_hint = if (sealed && field?.present == true) LockerCopy.KEPT_SEALED else "",
            secret = sealed,
            value_note = when {
                sealed && field?.present == true -> LockerCopy.KEPT_SEALED
                sealed -> LockerCopy.FIELD_SEALED_ON_SAVE
                else -> LockerCopy.FIELD_TEXT_NOTE
            },
            save_label = LockerCopy.FIELD_SAVE,
            cancel_label = LockerCopy.CANCEL,
            remove_label = if (field == null) "" else LockerCopy.FIELD_REMOVE,
            can_save = label.isNotEmpty(),
            blocked = if (label.isEmpty()) LockerCopy.FIELD_LABEL_MISSING else "",
        )
    }

    private fun editingField(held: LockerHeld<LockerItemState>): LockerField? =
        held.editing?.takeIf { it.isNotEmpty() }?.let { id -> item(held)?.fields?.firstOrNull { it.field_id == id } }

    private fun sheetKind(held: LockerHeld<LockerItemState>, sheet: LockerFieldSheet): String =
        editingField(held)?.kind ?: sheet.kinds.firstOrNull { it.selected }?.key ?: KIND_TEXT

    private fun fieldTyped(held: LockerHeld<LockerItemState>, key: String, value: String): LockerHeld<LockerItemState> {
        val sheet = held.screen.field_sheet ?: return held
        val typed = when (key) {
            "section" -> sheet.copy(section = value)
            "label" -> sheet.copy(label = value)
            "value" -> sheet.copy(value_ = value)
            else -> return held
        }
        return held.copy(screen = held.screen.copy(field_sheet = worded(typed, editingField(held), sheetKind(held, sheet))))
    }

    private fun fieldKind(held: LockerHeld<LockerItemState>, key: String): LockerHeld<LockerItemState> {
        val sheet = held.screen.field_sheet ?: return held
        // THE KIND IS CHOSEN ONCE, on a new field, as an item's type is.
        if (editingField(held) != null || key !in setOf(KIND_TEXT, KIND_SEALED)) return held
        return held.copy(screen = held.screen.copy(field_sheet = worded(sheet, null, key)))
    }

    /**
     * SAVE ONE FIELD. A new field's id is minted here from the bridge's CSPRNG
     * bytes, because a sealed value's ciphertext is bound to its row's id and
     * the core seals it before the row exists (D-1020-L9). An edited sealed
     * field with nothing typed sends the placeholder, which keeps what is
     * stored. The invoke key names the field and the attempt, never a value.
     */
    private fun fieldSaved(held: LockerHeld<LockerItemState>, entropy: ByteArray): Step<LockerHeld<LockerItemState>> {
        val item = item(held) ?: return Step(held)
        val sheet = held.screen.field_sheet ?: return Step(held)
        if (!sheet.can_save) return Step(held)
        val existing = editingField(held)
        val kind = sheetKind(held, sheet)
        val fieldId = existing?.field_id ?: mintedId(entropy) ?: return Step(held)
        val value = when {
            kind == KIND_SEALED && existing?.present == true && sheet.value_.isEmpty() -> LockerEditorMachine.PLACEHOLDER
            else -> sheet.value_
        }
        val section = sheet.section.trim()
        val position = existing?.position ?: item.fields.count { it.section == section }.toLong()
        val input = "{\"item_id\":${jsonString(item.item_id)},\"field_id\":${jsonString(fieldId)}," +
            "\"section\":${jsonString(section)},\"label\":${jsonString(sheet.label.trim())}," +
            "\"kind\":${jsonString(kind)},\"value\":${jsonString(value)},\"position\":$position}"
        return submit(held.copy(editing = fieldId), "locker.set_field", input, InvokeKeys.of("locker.set_field", fieldId, held.tokens.toString()))
    }

    private fun fieldRemoved(held: LockerHeld<LockerItemState>): Step<LockerHeld<LockerItemState>> {
        editingField(held) ?: return Step(held)
        return Step(
            held.copy(
                confirming = CONFIRM_FIELD,
                screen = held.screen.copy(
                    confirm = Confirm(
                        title = LockerCopy.FIELD_REMOVE_TITLE,
                        body = LockerCopy.FIELD_REMOVE_BODY,
                        confirm_label = LockerCopy.FIELD_REMOVE,
                        destructive = true,
                    ),
                ),
            ),
        )
    }

    /** 32 hex digits of the bridge's CSPRNG bytes, or null when a view sent none. */
    private fun mintedId(entropy: ByteArray): String? =
        entropy.takeIf { it.size >= 16 }?.take(16)?.joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }

    /** RENAME: the passkey's metadata round-trips and its key stays as the placeholder. */
    private fun passkeyNameSaved(held: LockerHeld<LockerItemState>): Step<LockerHeld<LockerItemState>> {
        val item = item(held) ?: return Step(held)
        val passkey = item.passkey ?: return Step(held)
        val name = held.screen.passkey_name?.text?.trim() ?: return Step(held)
        if (name == passkey.display_name) return Step(held.copy(screen = held.screen.copy(passkey_name = null)))
        val input = "{\"item_id\":${jsonString(item.item_id)},\"rp_id\":${jsonString(passkey.rp_id)}," +
            "\"user_handle\":${jsonString(passkey.user_handle)},\"display_name\":${jsonString(name)}," +
            "\"credential_id\":${jsonString(passkey.credential_id)},\"algorithm\":${jsonString(passkey.algorithm)}," +
            "\"private_key\":${jsonString(LockerEditorMachine.PLACEHOLDER)}}"
        return submit(held, "locker.set_passkey", input, InvokeKeys.of("locker.set_passkey", item.item_id, held.tokens.toString()))
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
                submitted.startsWith("locker.set_field") -> screen.copy(field_sheet = null, status = StatusLine(sentence = LockerCopy.FIELD_SAVED))
                submitted.startsWith("locker.remove_field") -> screen.copy(field_sheet = null, status = StatusLine(sentence = LockerCopy.FIELD_REMOVED))
                submitted.startsWith("locker.set_passkey") -> screen.copy(passkey_name = null, status = StatusLine(sentence = LockerCopy.PASSKEY_RENAMED))
                submitted.startsWith("locker.clear_passkey") -> screen.copy(status = StatusLine(sentence = LockerCopy.PASSKEY_REMOVED))
                else -> screen.copy(status = null)
            }
        }
        val closed = settled.invoke_key == submitted && settled.committed &&
            (submitted.startsWith("locker.set_field") || submitted.startsWith("locker.remove_field"))
        return Step(held.copy(screen = screen, editing = if (closed) null else held.editing), step.effects)
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
        val keep = held.shown?.let { shown -> item != null && storedSecret(item, shown.column) && !item.trashed }
        return if (keep == true) held else held.copy(shown = null)
    }

    /** Whether [key] names a sealed value this item holds: one of its cells, or a sealed field. */
    private fun storedSecret(item: LockerItem, key: String): Boolean =
        if (key.startsWith(FIELD)) {
            item.fields.any { "$FIELD${it.field_id}" == key && it.sealed_ && it.present }
        } else {
            item.secrets.any { it.column == key && it.present }
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
                val editable = !item.trashed
                add(
                    LockerSection(
                        title = section,
                        rows = fields.filter { it.present || editable }.map { field ->
                            val key = "$FIELD${field.field_id}"
                            val edit = if (editable) listOf(LockerVerb(key = "edit", label = LockerCopy.EDIT)) else emptyList()
                            when {
                                field.sealed_ && field.present -> sealedField(key, field.label, held, edit)
                                field.sealed_ -> LockerFieldRow(
                                    key = key,
                                    label = field.label,
                                    note = LockerCopy.FIELD_EMPTY,
                                    verbs = edit,
                                    accessibility_label = "${field.label}, ${LockerCopy.FIELD_EMPTY}",
                                )
                                else -> plain(key, field.label, field.value_, verbs = (if (field.value_.isEmpty()) emptyList() else copyOnly) + edit)
                            }
                        },
                    ),
                )
            }
            item.passkey?.let { passkey -> add(passkeySection(passkey, item.trashed)) }
            add(LockerSection(title = LockerCopy.DETAILS_HEAD, rows = details(item)))
            access(held, item)?.let { add(it) }
        }.filter { it.rows.isNotEmpty() }
        val actions = if (item.trashed) {
            listOf(
                LockerAction(key = "restore", label = LockerCopy.RESTORE),
                LockerAction(key = "purge", label = LockerCopy.PURGE_ACTION, destructive = true),
            )
        } else {
            listOfNotNull(
                LockerAction(key = "add_field", label = LockerCopy.FIELD_ADD),
                LockerAction(key = "star", label = if (item.starred) LockerCopy.UNSTAR else LockerCopy.STAR),
                LockerAction(key = "archive", label = if (item.archived) LockerCopy.UNARCHIVE else LockerCopy.ARCHIVE),
                item.passkey?.let { LockerAction(key = "remove_passkey", label = LockerCopy.PASSKEY_REMOVE, destructive = true) },
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
        return sealedField(column, labelOf(column), held, emptyList())
    }

    /**
     * A SEALED VALUE'S ROW — an item cell, or a custom field (#1047 T2): the
     * mask with Reveal and Copy (and [more], a field's Edit), revealed with
     * Copy and Conceal and its countdown, or the reveal in flight.
     */
    private fun sealedField(column: String, label: String, held: LockerHeld<LockerItemState>, more: List<LockerVerb>): LockerFieldRow {
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
                verbs = listOf(LockerVerb(key = "reveal", label = LockerCopy.REVEAL), LockerVerb(key = "copy", label = LockerCopy.COPY)) + more,
                accessibility_label = "$label, ${LockerCopy.SEALED}",
                monospace = true,
            )
        }
    }

    /**
     * THE PASSKEY SLOT (L-passkey): its metadata, a Rename on its name, and
     * its key as a mask with no verb — storage only, never shown or copied.
     */
    private fun passkeySection(passkey: centraid.core.v1.LockerPasskey, trashed: Boolean): LockerSection = LockerSection(
        title = LockerCopy.PASSKEY_HEAD,
        rows = listOfNotNull(
            plain("passkey:rp", LockerCopy.PASSKEY_SITE, passkey.rp_id),
            passkey.user_handle.takeIf { it.isNotEmpty() }?.let { plain("passkey:user", LockerCopy.PASSKEY_USER, it) },
            LockerFieldRow(
                key = "passkey:name",
                label = LockerCopy.PASSKEY_NAME,
                value_ = passkey.display_name.ifEmpty { LockerCopy.PASSKEY_UNNAMED },
                verbs = if (trashed) emptyList() else listOf(LockerVerb(key = "rename", label = LockerCopy.PASSKEY_RENAME)),
                accessibility_label = "${LockerCopy.PASSKEY_NAME}, ${passkey.display_name.ifEmpty { LockerCopy.PASSKEY_UNNAMED }}",
            ),
            dayRow("passkey:created", LockerCopy.CREATED, passkey.created_local_day),
            LockerFieldRow(
                key = "passkey:key",
                label = LockerCopy.PASSKEY_KEY,
                sealed_ = passkey.has_private_key,
                mask = if (passkey.has_private_key) DOTS else "",
                value_ = if (passkey.has_private_key) "" else LockerCopy.PASSKEY_NO_KEY,
                note = LockerCopy.PASSKEY_NOTE,
                accessibility_label = "${LockerCopy.PASSKEY_KEY}, ${LockerCopy.PASSKEY_NOTE}",
            ),
        ),
    )

    /**
     * THE ACCESS HISTORY (#1047 T2): one row per receipt, newest first — what
     * was opened, shown or copied, and when. A receipt never carried a value,
     * so neither does a row. Absent until the core has answered.
     */
    private fun access(held: LockerHeld<LockerItemState>, item: LockerItem): LockerSection? {
        val access = held.answers.access ?: return null
        val rows = access.entries.map { entry ->
            val column = entry.columns.firstOrNull().orEmpty()
            val subject = if (entry.field_id.isNotEmpty()) {
                item.fields.firstOrNull { it.field_id == entry.field_id }?.label ?: LockerCopy.ACCESS_FIELD_GONE
            } else {
                labelOf(column)
            }
            val label = when {
                entry.kind == LockerAccessKind.LOCKER_ACCESS_KIND_CODE && entry.copied -> LockerCopy.ACCESS_CODE_COPIED
                entry.kind == LockerAccessKind.LOCKER_ACCESS_KIND_CODE -> LockerCopy.ACCESS_CODE_SHOWN
                entry.copied -> LockerFold.fill(LockerCopy.ACCESS_COPIED, "field" to subject)
                else -> LockerFold.fill(LockerCopy.ACCESS_REVEALED, "field" to subject)
            }
            val day = entry.local_day.takeIf { it.length >= 10 }?.let { CivilWords.dayMonth(it) }.orEmpty()
            val `when` = listOf(day, entry.local_time).filter { it.isNotEmpty() }.joinToString(" · ")
            LockerFieldRow(
                key = "access:${entry.receipt_id}",
                label = label,
                value_ = `when`,
                note = if (entry.allowed) "" else LockerCopy.ACCESS_REFUSED,
                accessibility_label = listOf(label, `when`, if (entry.allowed) "" else LockerCopy.ACCESS_REFUSED).filter { it.isNotEmpty() }.joinToString(", "),
            )
        }.ifEmpty {
            listOf(LockerFieldRow(key = "access:none", label = LockerCopy.ACCESS_NONE, accessibility_label = LockerCopy.ACCESS_NONE))
        }
        val window = if (access.truncated) " ${LockerFold.fill(LockerCopy.ACCESS_WINDOW, "n" to access.window.toString())}" else ""
        return LockerSection(title = LockerCopy.ACCESS_HEAD, rows = rows, note = LockerCopy.ACCESS_NOTE + window)
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
            key.startsWith(FIELD) -> item.fields.firstOrNull { "$FIELD${it.field_id}" == key && !it.sealed_ }?.value_
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

    /** A copied sealed value's sentence, naming a custom field by its own label. */
    private fun copiedSentence(held: LockerHeld<LockerItemState>, column: String): String =
        if (column.startsWith(FIELD)) {
            val label = item(held)?.fields?.firstOrNull { "$FIELD${it.field_id}" == column }?.label ?: LockerCopy.FIELD_VALUE
            LockerFold.fill(LockerCopy.COPIED_SECRET, "field" to label)
        } else {
            copiedSentence(column)
        }

    private fun refusalSentence(refusal: LockerRevealRefusal): String = when (refusal) {
        LockerRevealRefusal.LOCKER_REVEAL_REFUSAL_LOCKED -> LockerCopy.REVEAL_LOCKED
        LockerRevealRefusal.LOCKER_REVEAL_REFUSAL_EMPTY -> LockerCopy.REVEAL_EMPTY
        LockerRevealRefusal.LOCKER_REVEAL_REFUSAL_NOT_SEALED -> LockerCopy.REVEAL_GONE
        LockerRevealRefusal.LOCKER_REVEAL_REFUSAL_NOT_A_SEED -> LockerCopy.CODE_NOT_A_SEED
        LockerRevealRefusal.LOCKER_REVEAL_REFUSAL_SEED_NOT_SHOWN -> LockerCopy.REVEAL_SEED
        LockerRevealRefusal.LOCKER_REVEAL_REFUSAL_KEY_NOT_SHOWN -> LockerCopy.PASSKEY_NOTE
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

/**
 * An item's page reads its access history too (#1047 T2), so a receipt the
 * page's own reveal wrote re-reads it: `access_receipt` is on its table set.
 */
public val LOCKER_ITEM_TABLES: Set<String> = LOCKER_TABLES + "access_receipt"

/** The most receipts the item page draws. */
public const val ACCESS_WINDOW: Int = 50

/** What one item asks. Nothing until it knows which item — or while locked. */
public object LockerItemReads : LockerQueries<LockerItemState, LockerItemEvent>(
    screenId = "locker.item",
    tables = LOCKER_ITEM_TABLES,
    ask = { held, now ->
        held.screen.item_id.takeIf { it.isNotEmpty() }?.let {
            listOf(
                AppQueryRequest(locker_item = LockerItemRequest(item_id = it, tz = now.zone)),
                AppQueryRequest(locker_access = LockerAccessRequest(item_id = it, limit = ACCESS_WINDOW, tz = now.zone)),
            )
        }
    },
)
