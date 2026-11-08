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

    @Environment(\.appAccent) private var accent

    var body: some View {
        // THE BOARD'S LARGE SHEET: the title and Done share the head, the rule's cards under it,
        // its sentence last.
        SheetRoom(title: "") {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(sheet.title.isEmpty ? fallbackTitle : sheet.title)
                        .kitType(.section)
                        .foregroundStyle(Surface.ink)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("kit-sheet-title")
                    Spacer(minLength: 8)
                    Button {
                        event { $0.customApplied = .init() }
                    } label: {
                        Text(sheet.doneLabel)
                            .kitType(.row)
                            .fontWeight(.semibold)
                            .foregroundStyle(sheet.canApply ? Color.white : Surface.meta)
                            .padding(.horizontal, 22)
                            .frame(minHeight: CentraidGeometry.targetMinCoarse)
                            .background(Capsule().fill(sheet.canApply ? accent.fill : Surface.fill))
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(!sheet.canApply)
                    .accessibilityIdentifier("agenda-editor-custom-done")
                }
                .padding(.top, 20)
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if sheet.readOnly {
                            Text(sheet.summary)
                                .centraidType("body")
                                .foregroundStyle(Theme.color("text", scheme))
                                .accessibilityIdentifier("agenda-editor-custom-summary")
                            KitOutlineButton(label: sheet.replaceLabel) { event { $0.customReplace = .init() } }
                                .accessibilityIdentifier("agenda-editor-custom-replace")
                        } else {
                            editable
                            Text(sheet.summary)
                                .centraidType("body")
                                .foregroundStyle(Theme.color("text", scheme))
                                .padding(.top, 4)
                                .accessibilityIdentifier("agenda-editor-custom-summary")
                        }
                        if !sheet.error.isEmpty {
                            Text(sheet.error)
                                .centraidType("annotLabel")
                                .foregroundStyle(Theme.color("net", scheme))
                                .accessibilityIdentifier("agenda-editor-custom-error")
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .presentationDetents([.large])
    }

    /// A plate of the sheet's own: the board's white card.
    private func card<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            content()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Surface.sheetCard, in: RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
    }

    /// THE FREQUENCY SEGMENTS: equal keys on one plate, the chosen one raised and in the app's ink.
    private func segments(_ choices: [Centraid_Core_V1_AgendaChoice], idPrefix: String, onPick: @escaping (String) -> Void) -> some View {
        HStack(spacing: 0) {
            ForEach(choices, id: \.key) { choice in
                Button { onPick(choice.key) } label: {
                    Text(choice.label)
                        .centraidType(choice.selected ? "smallStrong" : "small")
                        .foregroundStyle(choice.selected ? accent.text : Theme.color("textSoft", scheme))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .background {
                            if choice.selected {
                                RoundedRectangle(cornerRadius: Theme.radius("md", scheme), style: .continuous).fill(Surface.card)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(choice.selected ? .isSelected : [])
                .accessibilityLabel(choice.accessibilityLabel.isEmpty ? choice.label : choice.accessibilityLabel)
                .accessibilityIdentifier("\(idPrefix)-\(choice.key)")
            }
        }
        .padding(3)
        .background(Surface.fill, in: RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
    }

    /// THE WEEK IN ONE ROW: seven equal keys, the picked ones filled.
    private func weekRow(_ choices: [Centraid_Core_V1_AgendaChoice]) -> some View {
        HStack(spacing: 4) {
            ForEach(choices, id: \.key) { choice in
                Button {
                    event { $0.customWeekday = .with { $0.key = choice.key } }
                } label: {
                    Text(choice.label)
                        .centraidType(choice.selected ? "smallStrong" : "small")
                        .foregroundStyle(choice.selected ? Color.white : Theme.color("text", scheme))
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.radius("md", scheme), style: .continuous)
                                .fill(choice.selected ? accent.fill : Theme.color("bgSunken", scheme))
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(choice.selected ? .isSelected : [])
                .accessibilityLabel(choice.accessibilityLabel.isEmpty ? choice.label : choice.accessibilityLabel)
                .accessibilityIdentifier("agenda-editor-custom-weekday-\(choice.key)")
            }
        }
    }

    @ViewBuilder
    private var editable: some View {
        group(sheet.frequencyLabel.uppercased()) {
            segments(sheet.frequencies, idPrefix: "agenda-editor-custom-freq") { key in
                event { $0.customFreq = .with { $0.key = key } }
            }
        }
        card {
            stepperRow(
                label: sheet.intervalLabel,
                value: sheet.interval,
                unit: sheet.unitLabel,
                identifier: "agenda-editor-custom-interval"
            ) { interval in
                event { $0.customInterval = .with { $0.interval = interval } }
            }
        }
        if sheet.showWeekdays {
            card {
                Text(sheet.weekdaysLabel)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                weekRow(sheet.weekdays)
                    .padding(.bottom, 4)
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
        group(sheet.endsLabel.uppercased()) {
            VStack(spacing: 0) {
                ForEach(Array(sheet.endModes.enumerated()), id: \.element.key) { index, mode in
                    HStack(spacing: 12) {
                        Button { event { $0.customEnd = .with { $0.key = mode.key } } } label: {
                            HStack(spacing: 12) {
                                ZStack {
                                    Circle().strokeBorder(mode.selected ? accent.fill : Surface.border, lineWidth: 1.5)
                                    if mode.selected {
                                        Circle().fill(accent.fill)
                                        CentraidIconView(iconKey: "Check", tint: .white, size: 12)
                                    }
                                }
                                .frame(width: 22, height: 22)
                                Text(mode.label)
                                    .centraidType("body")
                                    .foregroundStyle(Theme.color("text", scheme))
                                Spacer(minLength: 0)
                            }
                            .frame(minHeight: CentraidGeometry.targetMinCoarse)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(mode.selected ? .isSelected : [])
                        .accessibilityLabel(mode.accessibilityLabel.isEmpty ? mode.label : mode.accessibilityLabel)
                        .accessibilityIdentifier("agenda-editor-custom-end-\(mode.key)")
                        if mode.key == "on", sheet.showUntil {
                            CivilDayPicker(label: sheet.untilDayLabel, day: sheet.untilDay) { day in
                                event { $0.customUntil = .with { $0.day = day } }
                            }
                            .accessibilityIdentifier("agenda-editor-custom-until")
                        }
                        if mode.key == "after", sheet.showCount {
                            stepperRow(
                                label: "",
                                value: sheet.count,
                                unit: sheet.countLabel,
                                identifier: "agenda-editor-custom-count"
                            ) { count in
                                event { $0.customCount = .with { $0.count = count } }
                            }
                            .fixedSize()
                        }
                    }
                    .padding(.horizontal, 16)
                    .overlay(alignment: .bottom) {
                        if index < sheet.endModes.count - 1 { KitHairline(inset: 16) }
                    }
                }
            }
            .background(Surface.sheetCard, in: RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
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
