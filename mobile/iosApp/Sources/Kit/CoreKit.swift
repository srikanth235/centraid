import Foundation

// THE RUST-OWNED SCREENS' VIEW VOCABULARY, MET BY THE KIT'S VIEWS (#1135).
//
// The kit's views (`EmptyStateView`, `StatusLineView`, `ConfirmSheet`,
// `CentraidRow`, `EditorRoom`, `ReadStateView`) were written against the
// `Centraid_Screen_V1_*` messages, which the apps not yet ported to Rust still
// send. A Rust-owned screen sends the same finished words as
// `Centraid_Core_V1_*` (`kit_screens.proto`), field for field, and these
// conversions let it use the same views unchanged. Every one is a copy of
// fields: nothing here words, counts or decides. They are deleted with the
// last `Centraid_Screen_V1_*` screen, when the kit's views take the core types.

extension Centraid_Core_V1_Denied {
    var legacy: Centraid_Screen_V1_Denied {
        var out = Centraid_Screen_V1_Denied()
        out.title = title
        out.body = body
        out.receipt = receipt
        return out
    }
}

extension Centraid_Core_V1_ImportSource {
    /// NO DOOR THE KIT CAN OPEN. Every import is a Rust event now — Agenda's
    /// calendar (`ImportRequested`, drawn by `AgendaHomeView`) and People's
    /// contacts (`ImportContactsTapped`, drawn by `PeopleHomeView`) — and the
    /// reminders have no door yet, so the kit draws the app's own action.
    var legacy: Centraid_Screen_V1_ImportSource { .unspecified }
}

extension Centraid_Core_V1_EmptyState {
    var legacy: Centraid_Screen_V1_EmptyState {
        var out = Centraid_Screen_V1_EmptyState()
        out.headline = headline
        out.body = body
        out.actionLabel = actionLabel
        out.importSource = importSource.legacy
        return out
    }
}

extension Centraid_Core_V1_StatusLine {
    var legacy: Centraid_Screen_V1_StatusLine {
        var out = Centraid_Screen_V1_StatusLine()
        out.sentence = sentence
        out.actionLabel = actionLabel
        out.refused = refused
        return out
    }
}

extension Centraid_Core_V1_StatusChip.Tone {
    var legacy: Centraid_Screen_V1_StatusChip.Tone {
        Centraid_Screen_V1_StatusChip.Tone(rawValue: rawValue) ?? .unspecified
    }
}

extension Centraid_Core_V1_StatusChip {
    var legacy: Centraid_Screen_V1_StatusChip {
        var out = Centraid_Screen_V1_StatusChip()
        out.label = label
        out.tone = tone.legacy
        return out
    }
}

extension Centraid_Core_V1_Confirm {
    var legacy: Centraid_Screen_V1_Confirm {
        var out = Centraid_Screen_V1_Confirm()
        out.title = title
        out.body = body
        out.confirmLabel = confirmLabel
        out.destructive = destructive
        return out
    }
}

extension Centraid_Core_V1_Autosave {
    /// Only the words and the refusal are drawn (`AutosaveStatus`); the rest is carried for completeness.
    var legacy: Centraid_Screen_V1_Autosave {
        var out = Centraid_Screen_V1_Autosave()
        out.phase = Centraid_Screen_V1_Autosave.Phase(rawValue: phase.rawValue) ?? .unspecified
        out.editSeq = editSeq
        out.savedSeq = savedSeq
        out.remoteChanged = remoteChanged
        out.savingSeq = savingSeq
        out.label = label
        out.refused = refused
        return out
    }
}

extension Centraid_Core_V1_ListRow {
    var legacy: Centraid_Screen_V1_ListRow {
        var out = Centraid_Screen_V1_ListRow()
        out.id = id
        out.title = title
        out.meta = meta
        out.trailing = trailing
        out.chips = chips.map(\.legacy)
        out.hueKey = hueKey
        out.accessibilityLabel = accessibilityLabel
        out.dimmed = dimmed
        out.pending = pending
        out.trailingTone = trailingTone.legacy
        return out
    }
}

extension Centraid_Core_V1_SearchAsk {
    var legacy: Centraid_Screen_V1_SearchAsk {
        var out = Centraid_Screen_V1_SearchAsk()
        out.label = label
        out.question = question
        out.scope = scope
        return out
    }
}

extension Centraid_Core_V1_SearchContainer {
    /// The kit's container row, whose tap the caller answers with this container's `route`:
    /// the legacy `target` is set empty only so the row is live.
    var legacy: Centraid_Screen_V1_SearchContainer {
        var out = Centraid_Screen_V1_SearchContainer()
        out.entity = entity
        out.id = id
        out.appID = appID
        out.kindLabel = kindLabel
        out.title = title
        out.iconKey = iconKey
        out.accessibilityLabel = accessibilityLabel
        out.target = Centraid_Screen_V1_ChatCard()
        return out
    }
}

extension Centraid_Core_V1_TrashRow {
    var legacy: Centraid_Screen_V1_TrashRow {
        var out = Centraid_Screen_V1_TrashRow()
        out.id = id
        out.title = title
        out.meta = meta
        out.iconKey = iconKey
        out.restoreLabel = restoreLabel
        out.purgeLabel = purgeLabel
        return out
    }
}

extension ScreenContent {
    /// A Rust-owned screen's failed read.
    static func failed(_ failure: Centraid_Core_V1_Failure) -> ScreenContent<Value> {
        .failure(failure.sentence, failure.remedy)
    }

    /// A Rust-owned screen's denial.
    static func gated(_ denied: Centraid_Core_V1_Denied) -> ScreenContent<Value> {
        .denied(denied.legacy)
    }
}
