package dev.centraid.shared

import centraid.core.v1.AppQueryResponse
import centraid.core.v1.LockerAccess
import centraid.core.v1.LockerAccessEntry
import centraid.core.v1.LockerAccessKind
import centraid.core.v1.LockerExportFormat
import centraid.core.v1.LockerField
import centraid.core.v1.LockerImportPlan
import centraid.core.v1.LockerImportRow
import centraid.core.v1.LockerImportVerdict
import centraid.core.v1.LockerItem
import centraid.core.v1.LockerItemDetail
import centraid.core.v1.LockerItemRow
import centraid.core.v1.LockerItems
import centraid.core.v1.LockerPasskey
import centraid.core.v1.LockerRevealRefusal
import centraid.core.v1.LockerSecret
import centraid.screen.v1.LockerAccessEvent
import centraid.screen.v1.LockerAccessState
import centraid.screen.v1.LockerExportEvent
import centraid.screen.v1.LockerExportState
import centraid.screen.v1.LockerHomeEvent
import centraid.screen.v1.LockerHomeState
import centraid.screen.v1.LockerImportEvent
import centraid.screen.v1.LockerImportState
import centraid.screen.v1.LockerItemEvent
import centraid.screen.v1.LockerItemState
import centraid.screen.v1.LockerLockEvent
import centraid.screen.v1.StatusChip
import centraid.screen.v1.WriteSettled
import dev.centraid.design.copy.LockerCopy
import dev.centraid.shared.apps.locker.ACCESS_ALL_WINDOW
import dev.centraid.shared.apps.locker.LOCKER_ACCESS_TABLES
import dev.centraid.shared.apps.locker.LOCKER_TABLES
import dev.centraid.shared.apps.locker.LockerAccessMachine
import dev.centraid.shared.apps.locker.LockerAccessReads
import dev.centraid.shared.apps.locker.LockerDoorAnswer
import dev.centraid.shared.apps.locker.LockerExportMachine
import dev.centraid.shared.apps.locker.LockerExportReads
import dev.centraid.shared.apps.locker.LockerHeld
import dev.centraid.shared.apps.locker.LockerHomeMachine
import dev.centraid.shared.apps.locker.LockerImportMachine
import dev.centraid.shared.apps.locker.LockerImportReads
import dev.centraid.shared.apps.locker.LockerInput
import dev.centraid.shared.apps.locker.LockerItemMachine
import dev.centraid.shared.apps.locker.LockerItemReads
import dev.centraid.shared.apps.locker.LockerJob
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import io.kotest.matchers.types.shouldBeInstanceOf

/**
 * LOCKER'S FOLLOW-UPS ON THE PHONE (#1047 T2): custom sealed fields, the
 * passkey slot, one item's access history, and import and export — asserted
 * on the machines over the core's typed answers, the way a shell drives them.
 */
class LockerTransferSpec : StringSpec({

    val now = DeviceClock.Reading(zone = "America/New_York", epochMillis = 0L)
    val secret = "rc-4411-secret"

    fun <S, E> ScreenMachine<LockerHeld<S>, LockerInput<E>>.run(vararg inputs: LockerInput<E>): Pair<LockerHeld<S>, List<ScreenEffect>> {
        var held = initial()
        val effects = mutableListOf<ScreenEffect>()
        inputs.forEach {
            val step: Step<LockerHeld<S>> = reduce(held, it)
            held = step.state
            effects += step.effects
        }
        return held to effects
    }

    fun <S, E> ScreenMachine<LockerHeld<S>, LockerInput<E>>.after(held: LockerHeld<S>, vararg inputs: LockerInput<E>): Step<LockerHeld<S>> {
        var state = held
        val effects = mutableListOf<ScreenEffect>()
        inputs.forEach {
            val step = reduce(state, it)
            state = step.state
            effects += step.effects
        }
        return Step(state, effects)
    }

    val bank = LockerItem(
        item_id = "item-bank",
        type = "login",
        title = "Bank",
        username = "maya@example.com",
        url = "https://bank.example.com",
        secrets = listOf(LockerSecret(column = "password", present = true)),
        fields = listOf(
            LockerField(field_id = "field-rc", section = "Recovery", label = "Recovery code", kind = "sealed", sealed_ = true, present = true),
            LockerField(field_id = "field-branch", section = "Recovery", label = "Branch", kind = "text", value_ = "Leeds", present = true),
        ),
        passkey = LockerPasskey(
            rp_id = "bank.example.com",
            user_handle = "maya",
            display_name = "Maya",
            credential_id = "cred-1",
            algorithm = "ES256",
            created_local_day = "2099-06-30",
            has_private_key = true,
        ),
    )

    fun itemAnswer(item: LockerItem = bank) = AppQueryResponse(locker_item = LockerItemDetail(item = item, today = "2099-06-30"))

    fun accessAnswer(vararg entries: LockerAccessEntry) =
        AppQueryResponse(locker_access = LockerAccess(entries = entries.toList(), window = 50))

    val item = LockerItemMachine
    fun itemView(event: LockerItemEvent) = LockerInput.View(event, ByteArray(128) { it.toByte() })
    fun openItem(vararg answers: AppQueryResponse): LockerHeld<LockerItemState> = item.run(
        itemView(LockerItemEvent(opened = LockerItemEvent.Opened(item_id = "item-bank", parent = "Items"))),
        LockerInput.Lock(open = true),
        LockerInput.Answered(answers.toList().ifEmpty { listOf(itemAnswer(), accessAnswer()) }),
    ).first

    fun rowsOf(held: LockerHeld<LockerItemState>, section: String) =
        held.screen.data_.shouldNotBeNull().sections.first { it.title == section }.rows

    // --- custom sealed fields -------------------------------------------------

    "a sealed custom field reveals and copies through the core, like the item's own secrets" {
        val opened = openItem()
        val sealed = rowsOf(opened, "Recovery").first { it.key == "field:field-rc" }
        sealed.sealed_.shouldBeTrue()
        sealed.value_ shouldBe ""
        sealed.verbs.map { it.key } shouldBe listOf("reveal", "copy", "edit")
        sealed.note shouldBe LockerCopy.SEALED_NOTE
        val asked = item.reduce(opened, itemView(LockerItemEvent(verb = LockerItemEvent.VerbTapped(key = "field:field-rc", verb = "reveal")))).state
        val ask = asked.asking.shouldNotBeNull()
        ask.fieldId shouldBe "field-rc"
        ask.copy.shouldBeFalse()
        val revealed = item.reduce(
            asked,
            LockerInput.Revealed(ask.token, LockerDoorAnswer.Session(open = true, revealed = LockerDoorAnswer.Revealed("item-bank", "value_sealed", secret, "rcp-1", 30_000))),
        ).state
        val shown = rowsOf(revealed, "Recovery").first { it.key == "field:field-rc" }
        shown.value_ shouldBe secret
        shown.verbs.map { it.key } shouldBe listOf("copy", "conceal")
        // COPY ON A CONCEALED FIELD asks the core for a copy, and the value
        // goes to the clipboard, never the screen.
        val copying = item.reduce(opened, itemView(LockerItemEvent(verb = LockerItemEvent.VerbTapped(key = "field:field-rc", verb = "copy")))).state
        copying.asking!!.copy.shouldBeTrue()
        val copied = item.reduce(
            copying,
            LockerInput.Revealed(copying.asking.token, LockerDoorAnswer.Session(open = true, revealed = LockerDoorAnswer.Revealed("item-bank", "value_sealed", secret, "rcp-2", 30_000))),
        ).state
        copied.screen.clipboard.shouldNotBeNull().sensitive.shouldBeTrue()
        copied.screen.status!!.sentence shouldBe "Recovery code copied. Clears in 30 seconds."
        copied.shown.shouldBeNull()
        // A plain field is copied as itself, never receipted.
        val plain = rowsOf(opened, "Recovery").first { it.key == "field:field-branch" }
        plain.value_ shouldBe "Leeds"
        plain.verbs.map { it.key } shouldBe listOf("copy", "edit")
    }

    "a new field is added one at a time, sealed by the core on save, and needs a label" {
        val opened = openItem()
        opened.screen.data_!!.actions.map { it.key } shouldContain "add_field"
        val sheet = item.reduce(opened, itemView(LockerItemEvent(action = LockerItemEvent.ActionTapped(key = "add_field")))).state
        val open = sheet.screen.field_sheet.shouldNotBeNull()
        open.title shouldBe LockerCopy.FIELD_NEW_TITLE
        open.kinds.map { it.key } shouldBe listOf("text", "sealed")
        open.can_save.shouldBeFalse()
        open.blocked shouldBe LockerCopy.FIELD_LABEL_MISSING
        open.remove_label shouldBe ""
        val typed = item.after(
            sheet,
            itemView(LockerItemEvent(field_kind = LockerItemEvent.FieldKindPicked(key = "sealed"))),
            itemView(LockerItemEvent(field_typed = LockerItemEvent.FieldTyped(key = "section", value_ = "Recovery"))),
            itemView(LockerItemEvent(field_typed = LockerItemEvent.FieldTyped(key = "label", value_ = "PIN"))),
            itemView(LockerItemEvent(field_typed = LockerItemEvent.FieldTyped(key = "value", value_ = "4412"))),
        ).state
        val ready = typed.screen.field_sheet.shouldNotBeNull()
        ready.secret.shouldBeTrue()
        ready.can_save.shouldBeTrue()
        ready.value_note shouldBe LockerCopy.FIELD_SEALED_ON_SAVE
        val saved = item.reduce(typed, itemView(LockerItemEvent(field_saved = LockerItemEvent.FieldSaved())))
        val write = saved.effects.filterIsInstance<ScreenEffect.SubmitWrite>().single()
        write.command shouldBe "locker.set_field"
        write.inputJson shouldContain "\"kind\":\"sealed\""
        write.inputJson shouldContain "\"value\":\"4412\""
        write.inputJson shouldContain "\"field_id\":\""
        write.inputJson shouldContain "\"label\":\"PIN\""
        // THE INVOKE KEY NAMES NO VALUE: a key is logged.
        write.invokeKey shouldNotContain "4412"
        val settled = item.reduce(saved.state, LockerInput.Settled(WriteSettled(invoke_key = write.invokeKey, committed = true))).state
        settled.screen.field_sheet.shouldBeNull()
        settled.screen.status!!.sentence shouldBe LockerCopy.FIELD_SAVED
    }

    "editing a sealed field shows nothing of it, keeps it on an empty entry, and removes it only when confirmed" {
        val opened = openItem()
        val editing = item.reduce(opened, itemView(LockerItemEvent(verb = LockerItemEvent.VerbTapped(key = "field:field-rc", verb = "edit")))).state
        val sheet = editing.screen.field_sheet.shouldNotBeNull()
        sheet.title shouldBe LockerCopy.FIELD_EDIT_TITLE
        sheet.label shouldBe "Recovery code"
        sheet.value_ shouldBe ""
        sheet.value_note shouldBe LockerCopy.KEPT_SEALED
        sheet.kinds.map { it.key } shouldBe emptyList()
        sheet.remove_label shouldBe LockerCopy.FIELD_REMOVE
        val renamed = item.after(
            editing,
            itemView(LockerItemEvent(field_typed = LockerItemEvent.FieldTyped(key = "label", value_ = "Recovery codes"))),
            itemView(LockerItemEvent(field_saved = LockerItemEvent.FieldSaved())),
        )
        val write = renamed.effects.filterIsInstance<ScreenEffect.SubmitWrite>().single()
        write.inputJson shouldContain "\"field_id\":\"field-rc\""
        write.inputJson shouldContain "\"value\":\"«sealed»\""
        // REMOVE ASKS FIRST.
        val asking = item.reduce(editing, itemView(LockerItemEvent(field_removed = LockerItemEvent.FieldRemoved()))).state
        asking.screen.confirm.shouldNotBeNull().title shouldBe LockerCopy.FIELD_REMOVE_TITLE
        val removed = item.reduce(asking, itemView(LockerItemEvent(confirmed = LockerItemEvent.Confirmed())))
        val remove = removed.effects.filterIsInstance<ScreenEffect.SubmitWrite>().single()
        remove.command shouldBe "locker.remove_field"
        remove.inputJson shouldContain "\"field_id\":\"field-rc\""
    }

    "a relock drops a field typed into the sheet" {
        val typed = item.after(
            openItem(),
            itemView(LockerItemEvent(action = LockerItemEvent.ActionTapped(key = "add_field"))),
            itemView(LockerItemEvent(field_kind = LockerItemEvent.FieldKindPicked(key = "sealed"))),
            itemView(LockerItemEvent(field_typed = LockerItemEvent.FieldTyped(key = "value", value_ = secret))),
        ).state
        val relocked = item.reduce(typed, LockerInput.Lock(open = false)).state
        relocked.screen.field_sheet.shouldBeNull()
        relocked.screen.encode().decodeToString() shouldNotContain secret
    }

    // --- passkeys -------------------------------------------------------------

    "a passkey shows its metadata, never offers its key, and is renamed and removed" {
        val opened = openItem()
        val rows = rowsOf(opened, LockerCopy.PASSKEY_HEAD)
        rows.first { it.key == "passkey:rp" }.value_ shouldBe "bank.example.com"
        rows.first { it.key == "passkey:user" }.value_ shouldBe "maya"
        val name = rows.first { it.key == "passkey:name" }
        name.value_ shouldBe "Maya"
        name.verbs.map { it.key } shouldBe listOf("rename")
        rows.first { it.key == "passkey:created" }.value_ shouldBe CivilWords.dayMonth("2099-06-30")
        val key = rows.first { it.key == "passkey:key" }
        key.sealed_.shouldBeTrue()
        key.verbs.map { it.key } shouldBe emptyList()
        key.note shouldBe LockerCopy.PASSKEY_NOTE
        // No verb reaches the core for the key, whatever a view sends.
        item.reduce(opened, itemView(LockerItemEvent(verb = LockerItemEvent.VerbTapped(key = "passkey:key", verb = "reveal")))).state.asking.shouldBeNull()
        item.reduce(opened, itemView(LockerItemEvent(verb = LockerItemEvent.VerbTapped(key = "passkey:key", verb = "copy")))).state.asking.shouldBeNull()

        val renaming = item.reduce(opened, itemView(LockerItemEvent(verb = LockerItemEvent.VerbTapped(key = "passkey:name", verb = "rename")))).state
        renaming.screen.passkey_name.shouldNotBeNull().text shouldBe "Maya"
        val renamed = item.after(
            renaming,
            itemView(LockerItemEvent(passkey_name_typed = LockerItemEvent.PasskeyNameTyped(text = "Maya at the bank"))),
            itemView(LockerItemEvent(passkey_name_saved = LockerItemEvent.PasskeyNameSaved())),
        )
        val write = renamed.effects.filterIsInstance<ScreenEffect.SubmitWrite>().single()
        write.command shouldBe "locker.set_passkey"
        write.inputJson shouldContain "\"display_name\":\"Maya at the bank\""
        write.inputJson shouldContain "\"rp_id\":\"bank.example.com\""
        write.inputJson shouldContain "\"credential_id\":\"cred-1\""
        write.inputJson shouldContain "\"private_key\":\"«sealed»\""

        opened.screen.data_!!.actions.map { it.key } shouldContain "remove_passkey"
        val asking = item.reduce(opened, itemView(LockerItemEvent(action = LockerItemEvent.ActionTapped(key = "remove_passkey")))).state
        asking.screen.confirm.shouldNotBeNull().title shouldBe LockerCopy.PASSKEY_REMOVE_TITLE
        val removed = item.reduce(asking, itemView(LockerItemEvent(confirmed = LockerItemEvent.Confirmed())))
        removed.effects.filterIsInstance<ScreenEffect.SubmitWrite>().single().command shouldBe "locker.clear_passkey"
    }

    "a passkey the phone cannot make says so" {
        LockerCopy.PASSKEY_NOTE shouldContain "cannot"
    }

    // --- access history -------------------------------------------------------

    "an item's access history is its receipts, newest first, and names no value" {
        LockerItemReads.requests(openItem(), now).shouldNotBeNull().mapNotNull { it.locker_access?.item_id } shouldBe listOf("item-bank")
        val opened = openItem(
            itemAnswer(),
            accessAnswer(
                LockerAccessEntry(receipt_id = "r3", kind = LockerAccessKind.LOCKER_ACCESS_KIND_CODE, copied = true, allowed = true, columns = listOf("otp_seed"), local_day = "2099-06-30", local_time = "22:04"),
                LockerAccessEntry(receipt_id = "r2", kind = LockerAccessKind.LOCKER_ACCESS_KIND_REVEAL, allowed = true, columns = listOf("value_sealed"), field_id = "field-rc", local_day = "2099-06-30", local_time = "22:02"),
                LockerAccessEntry(receipt_id = "r1", kind = LockerAccessKind.LOCKER_ACCESS_KIND_REVEAL, copied = true, allowed = true, columns = listOf("password"), local_day = "2099-06-29", local_time = "09:15"),
            ),
        )
        val section = opened.screen.data_!!.sections.first { it.title == LockerCopy.ACCESS_HEAD }
        section.rows.map { it.label } shouldBe listOf("Code copied", "Recovery code revealed", "Password copied")
        section.rows.first().value_ shouldBe "${CivilWords.dayMonth("2099-06-30")} · 22:04"
        section.note shouldBe LockerCopy.ACCESS_NOTE
        val none = openItem(itemAnswer(), accessAnswer()).screen.data_!!.sections.first { it.title == LockerCopy.ACCESS_HEAD }
        none.rows.single().label shouldBe LockerCopy.ACCESS_NONE
    }

    // --- the whole Locker's access history (Q-1047-21) --------------------------

    val access = LockerAccessMachine
    fun accessView(event: LockerAccessEvent) = LockerInput.View(event)
    fun openAccess(vararg answers: AppQueryResponse): LockerHeld<LockerAccessState> = access.run(
        accessView(LockerAccessEvent(opened = LockerAccessEvent.Opened())),
        LockerInput.Lock(open = true),
        LockerInput.Answered(answers.toList()),
    ).first
    fun wholeAnswer(entries: List<LockerAccessEntry> = emptyList(), window: Int = 200, truncated: Boolean = false) =
        AppQueryResponse(locker_access = LockerAccess(entries = entries, window = window, truncated = truncated))

    val everyKind = listOf(
        LockerAccessEntry(receipt_id = "r7", kind = LockerAccessKind.LOCKER_ACCESS_KIND_EXPORT, allowed = true, local_day = "2099-06-30", local_time = "22:09"),
        LockerAccessEntry(receipt_id = "r6", kind = LockerAccessKind.LOCKER_ACCESS_KIND_UNLOCK, allowed = true, local_day = "2099-06-30", local_time = "22:00"),
        LockerAccessEntry(receipt_id = "r5", kind = LockerAccessKind.LOCKER_ACCESS_KIND_CODE, copied = true, allowed = true, columns = listOf("otp_seed"), item_id = "item-bank", item_title = "Bank", local_day = "2099-06-30", local_time = "21:58"),
        LockerAccessEntry(receipt_id = "r4", kind = LockerAccessKind.LOCKER_ACCESS_KIND_REVEAL, copied = true, allowed = true, columns = listOf("value_sealed"), field_id = "field-rc", field_label = "Recovery code", item_id = "item-bank", item_title = "Bank", local_day = "2099-06-30", local_time = "21:50"),
        LockerAccessEntry(receipt_id = "r3", kind = LockerAccessKind.LOCKER_ACCESS_KIND_REVEAL, allowed = true, columns = listOf("value_sealed"), field_id = "field-gone", item_id = "item-bank", item_title = "Bank", local_day = "2099-06-29", local_time = "08:00"),
        LockerAccessEntry(receipt_id = "r2", kind = LockerAccessKind.LOCKER_ACCESS_KIND_REVEAL, allowed = false, columns = listOf("card_number"), item_id = "item-card", item_title = "Visa", local_day = "2099-06-29", local_time = "07:30"),
        LockerAccessEntry(receipt_id = "r1", kind = LockerAccessKind.LOCKER_ACCESS_KIND_REVEAL, allowed = true, columns = listOf("password"), item_id = "item-temp", local_day = "2099-06-28", local_time = "12:00"),
    )

    "the whole Locker's history asks for every receipt, with no item, and nothing while locked" {
        LockerAccessReads.requests(LockerAccessMachine.initial(), now).shouldBeNull()
        val asked = LockerAccessReads.requests(openAccess(), now).shouldNotBeNull().single().locker_access.shouldNotBeNull()
        asked.item_id shouldBe ""
        asked.limit shouldBe ACCESS_ALL_WINDOW
        asked.tz shouldBe now.zone
        // The item page's read is still its own item's.
        LockerItemReads.requests(openItem(), now).shouldNotBeNull().mapNotNull { it.locker_access?.item_id } shouldBe listOf("item-bank")
    }

    "every kind of receipt is a row: the act, the item it is about, the minute, a refusal" {
        val rows = openAccess(wholeAnswer(everyKind)).screen.data_.shouldNotBeNull().history.shouldNotBeNull().rows
        rows.map { it.label } shouldBe listOf(
            // An export and an unlock name no item.
            "Every item exported",
            "Locker unlocked",
            "Code copied · Bank",
            // A custom field by its label now; a removed one by the words for that.
            "Recovery code copied · Bank",
            "A removed field revealed · Bank",
            "Card number revealed · Visa",
            // A purge takes the row and leaves the receipt.
            "Password revealed · A removed item",
        )
        rows.map { it.value_ } shouldBe listOf(
            "${CivilWords.dayMonth("2099-06-30")} · 22:09",
            "${CivilWords.dayMonth("2099-06-30")} · 22:00",
            "${CivilWords.dayMonth("2099-06-30")} · 21:58",
            "${CivilWords.dayMonth("2099-06-30")} · 21:50",
            "${CivilWords.dayMonth("2099-06-29")} · 08:00",
            "${CivilWords.dayMonth("2099-06-29")} · 07:30",
            "${CivilWords.dayMonth("2099-06-28")} · 12:00",
        )
        // A REFUSAL IS MARKED, AND ONLY A REFUSAL; the spoken label carries it.
        rows.map { it.note } shouldBe listOf("", "", "", "", "", LockerCopy.ACCESS_REFUSED, "")
        rows[5].accessibility_label shouldContain LockerCopy.ACCESS_REFUSED
        rows.first().key shouldBe "access:r7"
    }

    "the whole Locker's history is inert: no verb, no secret, no value" {
        val data = openAccess(wholeAnswer(everyKind)).screen.data_.shouldNotBeNull()
        val rows = data.history.shouldNotBeNull().rows
        rows.forEach {
            it.verbs.isEmpty().shouldBeTrue()
            it.sealed_.shouldBeFalse()
            it.revealed.shouldBeFalse()
            it.mask shouldBe ""
            it.countdown.shouldBeNull()
        }
        data.lede shouldBe LockerCopy.ACCESS_ALL_LEDE
        data.history.shouldNotBeNull().note shouldBe LockerCopy.ACCESS_NOTE
        data.history.shouldNotBeNull().title shouldBe ""
        LockerCopy.ACCESS_NOTE shouldContain "never the value"
    }

    "a full window says where it ends, and an empty history says so rather than inventing a row" {
        val full = openAccess(wholeAnswer(everyKind, window = 200, truncated = true)).screen.data_.shouldNotBeNull()
        full.history.shouldNotBeNull().note shouldBe "${LockerCopy.ACCESS_NOTE} Latest 200 shown."
        val none = openAccess(wholeAnswer()).screen.data_.shouldNotBeNull().history.shouldNotBeNull()
        none.rows.single().label shouldBe LockerCopy.ACCESS_ALL_NONE
        none.rows.single().key shouldBe "access:none"
    }

    "the whole Locker's history draws the item page's rows, the item named on top" {
        val reveal = LockerAccessEntry(
            receipt_id = "r1", kind = LockerAccessKind.LOCKER_ACCESS_KIND_REVEAL, copied = true, allowed = true,
            columns = listOf("password"), item_id = "item-bank", item_title = "Bank", local_day = "2099-06-29", local_time = "09:15",
        )
        val page = openItem(itemAnswer(), accessAnswer(reveal)).screen.data_!!.sections.first { it.title == LockerCopy.ACCESS_HEAD }.rows.single()
        val whole = openAccess(wholeAnswer(listOf(reveal))).screen.data_.shouldNotBeNull().history.shouldNotBeNull().rows.single()
        page.label shouldBe "Password copied"
        whole.label shouldBe "Password copied · Bank"
        // The same receipt, the same minute, the same key.
        whole.value_ shouldBe page.value_
        whole.key shouldBe page.key
    }

    "a relock wipes the history, and a late answer to a locked Locker is dropped" {
        val drawn = openAccess(wholeAnswer(everyKind))
        drawn.screen.data_.shouldNotBeNull()
        val locked = access.reduce(drawn, LockerInput.Lock(open = false)).state
        locked.screen.data_.shouldBeNull()
        locked.answers.access.shouldBeNull()
        LockerAccessReads.requests(locked, now).shouldBeNull()
        val late = access.reduce(locked, LockerInput.Answered(listOf(wholeAnswer(everyKind)))).state
        late.screen.data_.shouldBeNull()
        late.answers.access.shouldBeNull()
        // Opened again, it reads afresh and shows what that read answers.
        val reopened = access.after(late, LockerInput.Lock(open = true), LockerInput.Answered(listOf(wholeAnswer(everyKind.take(1)))))
        reopened.state.screen.data_.shouldNotBeNull().history.shouldNotBeNull().rows.map { it.key } shouldBe listOf("access:r7")
    }

    "the history re-reads when a receipt, an item or a field changes, and on nothing else" {
        LockerAccessMachine.tables shouldBe LOCKER_ACCESS_TABLES
        LOCKER_ACCESS_TABLES shouldBe setOf("receipt", "locker_item", "locker_item_field")
        access.rowsChanged("receipt", listOf("k")).shouldNotBeNull()
        access.rowsChanged("core_tag", listOf("k")).shouldBeNull()
    }

    // --- export ---------------------------------------------------------------

    val export = LockerExportMachine
    fun exportView(event: LockerExportEvent) = LockerInput.View(event)
    fun counted() = AppQueryResponse(
        locker_items = LockerItems(items = listOf(LockerItemRow(item_id = "a", type = "login", title = "A")), total = 6, window = 20, archived_count = 1, trashed_count = 2),
    )
    fun openExport(): LockerHeld<LockerExportState> = export.run(
        exportView(LockerExportEvent(opened = LockerExportEvent.Opened(parent = "Locker"))),
        LockerInput.Lock(open = true),
        LockerInput.Answered(listOf(counted())),
    ).first

    "export says what leaves, in the handoff's words, before anything is written" {
        val data = openExport().screen.data_.shouldNotBeNull()
        data.lede shouldBe "This saves every item, including passwords, to an unencrypted file. Anything that opens it can read your secrets."
        data.what_value shouldBe "7 items, unencrypted"
        data.formats.map { it.key } shouldBe listOf("csv", "json")
        data.formats.first { it.selected }.key shouldBe "csv"
        data.leaves_out shouldBe LockerCopy.EXPORT_LEAVES_OUT
        data.commit_label shouldBe LockerCopy.EXPORT_COMMIT
        LockerExportReads.requests(openExport(), now).shouldNotBeNull().single().locker_items.shouldNotBeNull()
    }

    "export asks the confirm, then the owner check afresh, and only then the core" {
        val asked = export.reduce(openExport(), exportView(LockerExportEvent(commit = LockerExportEvent.CommitTapped()))).state
        asked.screen.confirm.shouldNotBeNull().destructive.shouldBeTrue()
        asked.job.shouldBeNull()
        val checking = export.reduce(asked, exportView(LockerExportEvent(confirmed = LockerExportEvent.Confirmed()))).state
        checking.screen.confirm.shouldBeNull()
        checking.screen.phase shouldBe LockerExportState.Phase.PHASE_CHECKING
        val prompt = checking.screen.prompt.shouldNotBeNull()
        prompt.reason shouldBe LockerCopy.EXPORT_PROMPT_REASON
        checking.job.shouldBeNull()
        // A CANCELLED CHECK WRITES NOTHING.
        val cancelled = export.reduce(
            checking,
            exportView(LockerExportEvent(answered = LockerLockEvent.PromptAnswered(token = prompt.token, outcome = LockerLockEvent.PromptAnswered.Outcome.OUTCOME_CANCELLED))),
        ).state
        cancelled.job.shouldBeNull()
        cancelled.screen.prompt.shouldBeNull()
        cancelled.screen.phase shouldBe LockerExportState.Phase.PHASE_IDLE
        cancelled.screen.status!!.sentence shouldBe LockerCopy.EXPORT_NOT_CONFIRMED
        // AN ANSWER TO ANOTHER TOKEN IS NOBODY'S.
        export.reduce(
            checking,
            exportView(LockerExportEvent(answered = LockerLockEvent.PromptAnswered(token = prompt.token + 7, outcome = LockerLockEvent.PromptAnswered.Outcome.OUTCOME_SUCCEEDED))),
        ).state.job.shouldBeNull()
        val writing = export.reduce(
            checking,
            exportView(LockerExportEvent(answered = LockerLockEvent.PromptAnswered(token = prompt.token, outcome = LockerLockEvent.PromptAnswered.Outcome.OUTCOME_SUCCEEDED))),
        ).state
        writing.screen.phase shouldBe LockerExportState.Phase.PHASE_WRITING
        val job = writing.job.shouldBeInstanceOf<LockerJob.Export>()
        job.format shouldBe LockerExportFormat.LOCKER_EXPORT_FORMAT_CSV
        writing.screen.data_!!.commit_label shouldBe ""
    }

    "the file goes to the save sheet and nowhere else, and is dropped on any answer" {
        val picked = export.reduce(openExport(), exportView(LockerExportEvent(format = LockerExportEvent.FormatPicked(key = "json")))).state
        var held = export.after(
            picked,
            exportView(LockerExportEvent(commit = LockerExportEvent.CommitTapped())),
            exportView(LockerExportEvent(confirmed = LockerExportEvent.Confirmed())),
        ).state
        held = export.reduce(
            held,
            exportView(LockerExportEvent(answered = LockerLockEvent.PromptAnswered(token = held.screen.prompt!!.token, outcome = LockerLockEvent.PromptAnswered.Outcome.OUTCOME_SUCCEEDED))),
        ).state
        val job = held.job.shouldBeInstanceOf<LockerJob.Export>()
        job.format shouldBe LockerExportFormat.LOCKER_EXPORT_FORMAT_JSON
        val file = LockerDoorAnswer.Exported("x".toByteArray() + secret.toByteArray(), "locker-2099-06-30.json", "application/json", itemCount = 7, unopened = 0)
        val saving = export.reduce(held, LockerInput.Worked(job.token, LockerDoorAnswer.Session(open = true, exported = file))).state
        saving.screen.phase shouldBe LockerExportState.Phase.PHASE_SAVING
        saving.file.shouldNotBeNull().name shouldBe "locker-2099-06-30.json"
        // THE FILE IS NEVER ON THE STATE A VIEW DRAWS.
        saving.screen.encode().decodeToString() shouldNotContain secret
        saving.file.toString() shouldNotContain secret
        val saved = export.reduce(saving, exportView(LockerExportEvent(save_settled = LockerExportEvent.SaveSettled(saved = true)))).state
        saved.file.shouldBeNull()
        saved.screen.phase shouldBe LockerExportState.Phase.PHASE_IDLE
        saved.screen.status!!.sentence shouldBe LockerCopy.EXPORT_WRITTEN
        val cancelled = export.reduce(saving, exportView(LockerExportEvent(save_settled = LockerExportEvent.SaveSettled(cancelled = true)))).state
        cancelled.file.shouldBeNull()
        cancelled.screen.status!!.sentence shouldBe LockerCopy.EXPORT_NOT_SAVED
        // A RELOCK DROPS IT TOO.
        export.reduce(saving, LockerInput.Lock(open = false)).state.file.shouldBeNull()
        // AND A FILE MISSING WHAT DID NOT OPEN SAYS SO.
        val partial = export.reduce(held, LockerInput.Worked(job.token, LockerDoorAnswer.Session(open = true, exported = LockerDoorAnswer.Exported("x".toByteArray(), "f.json", "application/json", 7, unopened = 2)))).state
        val done = export.reduce(partial, exportView(LockerExportEvent(save_settled = LockerExportEvent.SaveSettled(saved = true)))).state
        done.screen.status!!.sentence shouldContain "2"
    }

    // --- import ---------------------------------------------------------------

    val import = LockerImportMachine
    fun importView(event: LockerImportEvent) = LockerInput.View(event)
    fun openImport(): LockerHeld<LockerImportState> = import.run(
        importView(LockerImportEvent(opened = LockerImportEvent.Opened(parent = "Locker"))),
        LockerInput.Lock(open = true),
        LockerInput.Answered(listOf(counted())),
    ).first
    val file = "name,url,username,password\nShop,shop.example,maya,$secret\n".encodeToByteArray()
    val plan = LockerImportPlan(
        format = "csv",
        rows = listOf(
            LockerImportRow(title = "Shop", type = "login", subtitle = "maya · shop.example", verdict = LockerImportVerdict.LOCKER_IMPORT_VERDICT_NEW, carries_secret = true),
            LockerImportRow(title = "Bank", type = "login", subtitle = "maya · bank.example.com", verdict = LockerImportVerdict.LOCKER_IMPORT_VERDICT_HELD, matched_item_id = "item-bank", carries_secret = true),
        ),
        new_count = 1,
        held_count = 1,
    )

    "import reads a picked file through the core, and plans before anything is written" {
        val idle = openImport().screen
        idle.phase shouldBe LockerImportState.Phase.PHASE_IDLE
        val idleData = idle.data_.shouldNotBeNull()
        idleData.choose_label shouldBe LockerCopy.IMPORT_CHOOSE
        idleData.verdicts.map { it.label } shouldBe listOf("NEW", "FILLS", "HELD", "SKIPPED")
        idleData.verdicts.first { it.label == "HELD" }.detail shouldBe "already in Locker, kept as is"
        val reading = import.reduce(openImport(), LockerInput.Picked("passwords.csv", file)).state
        reading.screen.phase shouldBe LockerImportState.Phase.PHASE_READING
        val job = reading.job.shouldBeInstanceOf<LockerJob.Import>()
        job.publish.shouldBeFalse()
        reading.file.shouldNotBeNull().name shouldBe "passwords.csv"
        reading.screen.encode().decodeToString() shouldNotContain secret
        val planned = import.reduce(reading, LockerInput.Worked(job.token, LockerDoorAnswer.Session(open = true, plan = plan))).state
        planned.screen.phase shouldBe LockerImportState.Phase.PHASE_PLANNED
        val data = planned.screen.data_.shouldNotBeNull()
        data.counts shouldBe "1 new · 0 fill gaps · 1 held · 0 skipped"
        data.rows.map { it.chip!!.label } shouldBe listOf("NEW", "HELD")
        data.rows.last().chip!!.tone shouldBe StatusChip.Tone.TONE_SEAM
        data.rows.first().meta shouldContain "maya · shop.example"
        data.publish_label shouldBe LockerCopy.IMPORT_PUBLISH
        data.file_value shouldBe "passwords.csv"
        planned.screen.encode().decodeToString() shouldNotContain secret
    }

    "add writes the plan and drops the file; discard writes nothing" {
        val reading = import.reduce(openImport(), LockerInput.Picked("passwords.csv", file)).state
        val planned = import.reduce(reading, LockerInput.Worked(reading.job!!.token, LockerDoorAnswer.Session(open = true, plan = plan))).state
        val publishing = import.reduce(planned, importView(LockerImportEvent(publish = LockerImportEvent.PublishTapped()))).state
        publishing.screen.phase shouldBe LockerImportState.Phase.PHASE_PUBLISHING
        val job = publishing.job.shouldBeInstanceOf<LockerJob.Import>()
        job.publish.shouldBeTrue()
        val published = import.reduce(
            publishing,
            LockerInput.Worked(job.token, LockerDoorAnswer.Session(open = true, plan = plan.copy(published = true, created = 1))),
        ).state
        published.screen.phase shouldBe LockerImportState.Phase.PHASE_PUBLISHED
        published.file.shouldBeNull()
        published.screen.status!!.sentence shouldBe "Added 1, filled 0, kept 1"
        published.screen.data_!!.publish_label shouldBe ""
        val discarded = import.reduce(planned, importView(LockerImportEvent(discard = LockerImportEvent.DiscardTapped()))).state
        discarded.file.shouldBeNull()
        discarded.job.shouldBeNull()
        discarded.screen.phase shouldBe LockerImportState.Phase.PHASE_IDLE
        discarded.screen.status!!.sentence shouldBe LockerCopy.IMPORT_DISCARDED
    }

    "a file that is not a password export is refused in words, and a relock drops a picked file" {
        val reading = import.reduce(openImport(), LockerInput.Picked("statement.csv", file)).state
        val refused = import.reduce(
            reading,
            LockerInput.Worked(reading.job!!.token, LockerDoorAnswer.Session(open = true, refusal = LockerRevealRefusal.LOCKER_REVEAL_REFUSAL_NOT_READABLE)),
        ).state
        refused.screen.phase shouldBe LockerImportState.Phase.PHASE_IDLE
        val status = refused.screen.status.shouldNotBeNull()
        status.sentence shouldBe LockerCopy.IMPORT_NOT_READABLE
        status.refused.shouldBeTrue()
        refused.file.shouldBeNull()
        import.reduce(reading, LockerInput.Lock(open = false)).state.file.shouldBeNull()
    }

    // --- the More sheet -------------------------------------------------------

    "the More sheet offers Import and Export beside the trash, and the whole Locker's Access history" {
        val (home, _) = LockerHomeMachine.run(
            LockerInput.View(LockerHomeEvent(opened = LockerHomeEvent.Opened())),
            LockerInput.Lock(open = true),
        )
        val rows = home.screen.chrome.shouldNotBeNull().more_rows
        rows.map { it.key } shouldBe listOf("import", "trash", "export", "access", "facts", "lock")
        val row = rows.first { it.key == "access" }
        row.label shouldBe LockerCopy.MORE_ACCESS
        row.meta shouldBe LockerCopy.MORE_ACCESS_META
        row.icon_key shouldBe "History"
        // An intent: the machine changes nothing and the shell pushes the page.
        val picked = LockerHomeMachine.reduce(home, LockerInput.View(LockerHomeEvent(more = LockerHomeEvent.MorePicked(key = "access")))).state
        picked.screen.destination shouldBe home.screen.destination
        picked.screen.sheet shouldBe LockerHomeState.Sheet.SHEET_NONE
    }

    "the new screens read Locker's tables and nothing while locked" {
        LockerExportMachine.tables shouldBe LOCKER_TABLES
        LockerImportMachine.tables shouldBe LOCKER_TABLES
        LockerExportReads.requests(LockerExportMachine.initial(), now).shouldBeNull()
        LockerImportReads.requests(LockerImportMachine.initial(), now).shouldBeNull()
    }
})
