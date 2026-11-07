import SwiftUI

// THE EVENT EDITOR'S WAVE 2 SHEETS (#1173): the custom repeat, and the place and zone pickers.
//
// **THE VIEW DECIDES NOTHING.** Every label, choice, selected mark, flag (`show_*`), the rule's
// sentence, its error and whether Done is armed is on the state, made in Rust. A tap is one
// `AgendaEditorEvent`; the sheet holds no rule of its own.

/// A wrapping run of chips: the choices of one list, the picked ones lit.
private struct AgendaChipFlow: View {
    let choices: [Centraid_Core_V1_AgendaChoice]
    let idPrefix: String
    var minimum: CGFloat = 72
    let onPick: (String) -> Void

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: minimum), spacing: 6, alignment: .leading)], alignment: .leading, spacing: 0) {
            ForEach(choices, id: \.key) { choice in
                KitChip(
                    label: choice.label,
                    selected: choice.selected,
                    spoken: choice.accessibilityLabel,
                    identifier: "\(idPrefix)-\(choice.key)"
                ) {
                    onPick(choice.key)
                }
            }
        }
    }
}

/// THE CUSTOM REPEAT SHEET: frequency, every N, weekdays, the monthly mode and the end, over the
/// rule's own sentence. A rule it cannot show is read-only: the sentence, and Replace.
struct AgendaCustomRepeatSheetView: View {
    let sheet: Centraid_Core_V1_AgendaCustomRepeatSheet
    /// The chrome's own name for the sheet, for a sheet state that carries none.
    var fallbackTitle: String = ""
    let send: (Centraid_Core_V1_AgendaEditorEvent) -> Void

    @Environment(\.colorScheme) private var scheme

    private func event(_ build: (inout Centraid_Core_V1_AgendaEditorEvent) -> Void) {
        var event = Centraid_Core_V1_AgendaEditorEvent()
        build(&event)
        send(event)
    }

    var body: some View {
        SheetRoom(
            title: sheet.title.isEmpty ? fallbackTitle : sheet.title,
            primary: SheetPrimary(
                label: sheet.doneLabel,
                enabled: sheet.canApply,
                identifier: "agenda-editor-custom-done"
            ) {
                event { $0.customApplied = .init() }
            }
        ) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text(sheet.summary)
                        .centraidType("body")
                        .foregroundStyle(Theme.color("text", scheme))
                        .accessibilityIdentifier("agenda-editor-custom-summary")
                    if !sheet.error.isEmpty {
                        Text(sheet.error)
                            .centraidType("annotLabel")
                            .foregroundStyle(Theme.color("net", scheme))
                            .accessibilityIdentifier("agenda-editor-custom-error")
                    }
                    if sheet.readOnly {
                        KitOutlineButton(label: sheet.replaceLabel) { event { $0.customReplace = .init() } }
                            .accessibilityIdentifier("agenda-editor-custom-replace")
                    } else {
                        editable
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    @ViewBuilder
    private var editable: some View {
        group(sheet.frequencyLabel) {
            AgendaChipFlow(choices: sheet.frequencies, idPrefix: "agenda-editor-custom-freq", minimum: 80) { key in
                event { $0.customFreq = .with { $0.key = key } }
            }
        }
        stepperRow(
            label: sheet.intervalLabel,
            value: sheet.interval,
            unit: sheet.unitLabel,
            identifier: "agenda-editor-custom-interval"
        ) { interval in
            event { $0.customInterval = .with { $0.interval = interval } }
        }
        if sheet.showWeekdays {
            group(sheet.weekdaysLabel) {
                AgendaChipFlow(choices: sheet.weekdays, idPrefix: "agenda-editor-custom-weekday", minimum: 56) { key in
                    event { $0.customWeekday = .with { $0.key = key } }
                }
            }
        }
        if sheet.showMonthModes {
            AgendaChipFlow(choices: sheet.monthModes, idPrefix: "agenda-editor-custom-month-mode", minimum: 120) { key in
                event { $0.customMonthMode = .with { $0.key = key } }
            }
        }
        if sheet.showMonthDays {
            group(sheet.monthDaysLabel) {
                AgendaChipFlow(choices: sheet.monthDays, idPrefix: "agenda-editor-custom-month-day", minimum: 48) { key in
                    event { $0.customMonthDay = .with { $0.key = key } }
                }
            }
        }
        if sheet.showNth {
            AgendaChipFlow(choices: sheet.ordinals, idPrefix: "agenda-editor-custom-ordinal", minimum: 72) { key in
                event { $0.customOrdinal = .with { $0.key = key } }
            }
            AgendaChipFlow(choices: sheet.nthWeekdays, idPrefix: "agenda-editor-custom-nth-weekday", minimum: 56) { key in
                event { $0.customNthWeekday = .with { $0.key = key } }
            }
        }
        group(sheet.endsLabel) {
            AgendaChipFlow(choices: sheet.endModes, idPrefix: "agenda-editor-custom-end", minimum: 96) { key in
                event { $0.customEnd = .with { $0.key = key } }
            }
        }
        if sheet.showUntil {
            CivilDayPicker(label: sheet.untilDayLabel, day: sheet.untilDay) { day in
                event { $0.customUntil = .with { $0.day = day } }
            }
            .accessibilityIdentifier("agenda-editor-custom-until")
        }
        if sheet.showCount {
            stepperRow(
                label: "",
                value: sheet.count,
                unit: sheet.countLabel,
                identifier: "agenda-editor-custom-count"
            ) { count in
                event { $0.customCount = .with { $0.count = count } }
            }
        }
    }

    /// A small heading over a run of controls.
    private func group<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if !label.isEmpty {
                Text(label)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
            content()
        }
    }

    /// "Every [n] weeks": the stepper's value and its words are Rust's; the number is the rule's.
    private func stepperRow(
        label: String,
        value: Int32,
        unit: String,
        identifier: String,
        onChange: @escaping (Int32) -> Void
    ) -> some View {
        Stepper(
            value: Binding(get: { Int(value) }, set: { onChange(Int32($0)) }),
            in: 1 ... 999
        ) {
            HStack(spacing: 6) {
                if !label.isEmpty {
                    Text(label)
                        .centraidType("body")
                        .foregroundStyle(Theme.color("text", scheme))
                }
                Text(String(value))
                    .centraidType("body")
                    .monospacedDigit()
                    .foregroundStyle(Theme.color("text", scheme))
                if !unit.isEmpty {
                    Text(unit)
                        .centraidType("body")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }
            }
        }
        .frame(minHeight: CentraidGeometry.targetMinCoarse)
        .accessibilityIdentifier(identifier)
    }
}

/// THE PLACE AND ZONE PICKERS: a search field over the choices, the chosen one marked. The field
/// is the member's own typing (seeded once from what Rust holds), forwarded as it changes; which
/// choices match is Rust's. `clearLabel` adds the row that takes the choice off.
struct AgendaSearchChoiceSheet: View {
    let title: String
    let placeholder: String
    let searchIdentifier: String
    let idPrefix: String
    let choices: [Centraid_Core_V1_AgendaChoice]
    var clearLabel: String = ""
    var clearIdentifier: String = ""
    let onSearch: (String) -> Void
    let onPick: (String) -> Void
    var onClear: () -> Void = {}

    @State private var typed: String

    @Environment(\.colorScheme) private var scheme

    init(
        title: String,
        placeholder: String,
        query: String,
        searchIdentifier: String,
        idPrefix: String,
        choices: [Centraid_Core_V1_AgendaChoice],
        clearLabel: String = "",
        clearIdentifier: String = "",
        onSearch: @escaping (String) -> Void,
        onPick: @escaping (String) -> Void,
        onClear: @escaping () -> Void = {}
    ) {
        self.title = title
        self.placeholder = placeholder
        self.searchIdentifier = searchIdentifier
        self.idPrefix = idPrefix
        self.choices = choices
        self.clearLabel = clearLabel
        self.clearIdentifier = clearIdentifier
        self.onSearch = onSearch
        self.onPick = onPick
        self.onClear = onClear
        _typed = State(initialValue: query)
    }

    var body: some View {
        SheetRoom(title: title) {
            TextField(placeholder, text: $typed)
                .centraidType("body")
                .foregroundStyle(Theme.color("text", scheme))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .padding(.horizontal, 12)
                .frame(minHeight: CentraidGeometry.targetMinCoarse)
                .background(Theme.color("bgSunken", scheme), in: RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
                .accessibilityLabel(placeholder)
                .accessibilityIdentifier(searchIdentifier)
                .onChange(of: typed) { _, text in onSearch(text) }
            ScrollView {
                VStack(spacing: 0) {
                    if !clearLabel.isEmpty {
                        SheetRow(label: clearLabel, identifier: clearIdentifier, onTap: onClear)
                    }
                    ForEach(choices, id: \.key) { choice in
                        SheetRow(
                            label: choice.label,
                            selected: choice.selected,
                            identifier: "\(idPrefix)-\(choice.key)"
                        ) {
                            onPick(choice.key)
                        }
                        .accessibilityLabel(choice.accessibilityLabel.isEmpty ? choice.label : choice.accessibilityLabel)
                    }
                }
                .background(Surface.sheetCard)
                .clipShape(RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
            }
        }
    }
}
