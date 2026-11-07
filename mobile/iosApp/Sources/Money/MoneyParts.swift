import SwiftProtobuf
import SwiftUI

// MONEY'S SHARED DRAWING PARTS (#1099).
//
// Every word here is the state's. An amount is the vault's `Money{minor,
// currency, exponent}` drawn by the kit's one formatter (`Kit/Money.swift`) at
// the state's own exponent; nothing here adds two amounts, picks a sign, a tone
// or a currency. The twin of Android's `screens/money/MoneyParts.kt`.

/// The words a view assembles from the state's own: a finished amount, a spoken
/// phrase. Nothing decided, only joined. An amount arrives finished from Rust
/// (`kit::money` is the one formatter); nothing here renders, signs or sums one.
enum MoneyWords {
    static func amount(_ money: String) -> String { money }

    /// The state's words, then the finished amount after them.
    static func spoken(_ words: String, _ money: String? = nil) -> String {
        [words, money ?? ""].filter { !$0.isEmpty }.joined(separator: ", ")
    }

    /// Two clauses of one meta line.
    static func meta(_ parts: String...) -> String {
        parts.filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
    }

    /// The one status line a page hosts: Rust's own, or an empty one.
    static func line(_ status: Centraid_Core_V1_StatusLine?) -> Centraid_Core_V1_StatusLine {
        status ?? Centraid_Core_V1_StatusLine()
    }
}

// MARK: - The read law, per state

extension Centraid_Core_V1_MoneyHomeState {
    var readContent: ScreenContent<Centraid_Core_V1_MoneyHomeData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failure(failure.sentence, failure.remedy)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}

extension Centraid_Core_V1_MoneyTransactionState {
    var readContent: ScreenContent<Centraid_Core_V1_MoneyTransactionData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failure(failure.sentence, failure.remedy)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}

extension Centraid_Core_V1_MoneyTargetState {
    var readContent: ScreenContent<Centraid_Core_V1_MoneyTargetData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failure(failure.sentence, failure.remedy)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}

extension Centraid_Core_V1_MoneyRecurringState {
    var readContent: ScreenContent<Centraid_Core_V1_MoneyRecurringData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failure(failure.sentence, failure.remedy)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}

extension Centraid_Core_V1_MoneyImportState {
    var readContent: ScreenContent<Centraid_Core_V1_MoneyImportData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failure(failure.sentence, failure.remedy)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}

extension Centraid_Core_V1_MoneyAccountsState {
    var readContent: ScreenContent<Centraid_Core_V1_MoneyAccountsData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failure(failure.sentence, failure.remedy)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}

extension Centraid_Core_V1_MoneyRulesState {
    var readContent: ScreenContent<Centraid_Core_V1_MoneyRulesData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failure(failure.sentence, failure.remedy)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}

extension Centraid_Core_V1_MoneyCategoriesState {
    var readContent: ScreenContent<Centraid_Core_V1_MoneyCategoriesData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failure(failure.sentence, failure.remedy)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}

extension Centraid_Core_V1_MoneySearchState {
    /// `resting` is a fifth arm the search page draws before the read: it is not
    /// a read, so it maps to loading here and the page checks it first.
    var readContent: ScreenContent<Centraid_Core_V1_MoneySearchData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failure(failure.sentence, failure.remedy)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}

extension ScreenContent {
    /// The data, when the read has landed.
    var loaded: Value? {
        if case let .data(value) = self { return value }
        return nil
    }
}

// MARK: - A sheet's binding

/// READ from the state, WRITTEN as an event: a swiped-away sheet tells the
/// machine, and the machine closes it.
@MainActor
func moneySheetBinding(_ open: Bool, close: @escaping @MainActor @Sendable () -> Void) -> Binding<Bool> {
    Binding(
        get: { open },
        set: { now in
            guard !now, open else { return }
            MainActor.assumeIsolated { close() }
        }
    )
}

// MARK: - The inset a row draws with

private struct MoneyInsetKey: EnvironmentKey {
    static let defaultValue: CGFloat = CentraidGeometry.pageMargin
}

extension EnvironmentValues {
    /// The side gutter a Money row draws with: the page's margin, and none inside
    /// a sheet, whose room already pads its own content.
    var moneyInset: CGFloat {
        get { self[MoneyInsetKey.self] }
        set { self[MoneyInsetKey.self] = newValue }
    }
}

private struct MoneyIdentifier: ViewModifier {
    let identifier: String
    func body(content: Content) -> some View {
        if identifier.isEmpty { content } else { content.accessibilityIdentifier(identifier) }
    }
}

// MARK: - Text





/// A switch row: the state's label and whether it is on. The toggle is an event
/// the screen forwards.
struct MoneyToggleRow: View {
    let label: String
    let on: Bool
    let identifier: String
    let onToggle: () -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.moneyInset) private var inset

    var body: some View {
        Toggle(isOn: Binding(get: { on }, set: { value in if value != on { onToggle() } })) {
            Text(label)
                .centraidType("body")
                .foregroundStyle(Theme.color("text", scheme))
        }
        .kitToggle()
        .padding(.horizontal, inset)
        .frame(minHeight: CentraidGeometry.targetMinCoarse)
        .accessibilityIdentifier(identifier)
    }
}

// MARK: - Fields

/// A TEXT FIELD THE MACHINE HOLDS, under its label (`MachineTextField` keeps the
/// keystrokes without a round trip each). An empty `key` draws no label.
struct MoneyTextField: View {
    let key: String
    let value: String
    var placeholder: String = ""
    var identifier: String = ""
    var focusOnAppear: Bool = false
    /// The amount a screen is about, at display size (a target's figure).
    var large: Bool = false
    let onEdit: (String) -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.moneyInset) private var inset

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if !key.isEmpty {
                Text(key)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
            MachineTextField(placeholder: placeholder, value: value, focusOnAppear: focusOnAppear, onEdit: onEdit)
                .centraidType(large ? "display" : "body")
                .foregroundStyle(Theme.color("text", scheme))
                .accessibilityLabel(key.isEmpty ? placeholder : key)
                .modifier(MoneyIdentifier(identifier: identifier))
        }
        .padding(.horizontal, inset)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
        .overlay(alignment: .bottom) { KitHairline() }
    }
}

/// A FIELD WHOSE VALUE IS A CHOICE: tapping opens the choice (a sheet, never a push).
struct MoneyChoiceField: View {
    let key: String
    let value: String
    var identifier: String = ""
    let onTap: () -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.moneyInset) private var inset

    var body: some View {
        Button(action: onTap) {
            HStack {
                Text(key)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("text", scheme))
                Spacer(minLength: 8)
                Text(value)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .lineLimit(1)
                CentraidIconView(iconKey: "ChevronRight", tint: Theme.color("textFaint", scheme), size: 14)
            }
            .padding(.horizontal, inset)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
            .overlay(alignment: .bottom) { KitHairline() }
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityElement(children: .combine)
        .modifier(MoneyIdentifier(identifier: identifier))
    }
}

/// A ROW OF CHOICES AS CHIPS (a kind, a sign convention, a date order): one
/// selected at most, each tap the screen's own event.
struct MoneyChoiceChips: View {
    let choices: [Centraid_Core_V1_MoneyChoice]
    let identifierPrefix: String
    let onPick: (String) -> Void

    @Environment(\.moneyInset) private var inset

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(choices.enumerated()), id: \.offset) { _, choice in
                    KitChip(
                        label: choice.label,
                        selected: choice.selected,
                        identifier: "\(identifierPrefix)-\(choice.key)",
                        action: { onPick(choice.key) }
                    )
                }
            }
            .padding(.horizontal, inset)
            .padding(.vertical, 4)
        }
    }
}

// MARK: - Buttons

/// THE PAGE'S ONE INK BUTTON, padded to the gutter.
struct MoneyInkButton: View {
    let label: String
    var enabled: Bool = true
    var destructive: Bool = false
    let identifier: String
    let action: () -> Void

    @Environment(\.moneyInset) private var inset
    /// A `MoneyChoiceStack` carries the gutter and the gaps itself.
    @Environment(\.inChoiceStack) private var stacked

    var body: some View {
        KitInkButton(label: label, destructive: destructive, identifier: identifier, action: action)
            .disabled(!enabled)
            .padding(.horizontal, stacked ? 0 : inset)
            .padding(.vertical, stacked ? 0 : 8)
    }
}

/// A SECONDARY VERB, padded to the gutter. `tone` is an ink role (`net` for a removal).
struct MoneyQuietButton: View {
    let label: String
    var tone: String = "text"
    let identifier: String
    let action: () -> Void

    @Environment(\.moneyInset) private var inset
    /// A `MoneyChoiceStack` carries the gutter and the gaps itself.
    @Environment(\.inChoiceStack) private var stacked

    var body: some View {
        HStack {
            KitOutlineButton(label: label, tone: tone, action: action)
                .accessibilityIdentifier(identifier)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, stacked ? 0 : inset)
        .padding(.vertical, stacked ? 0 : 6)
    }
}

/// ALTERNATIVES, PADDED TO THE GUTTER: a `KitChoiceStack` whose buttons (and
/// the notes between them) share the page's margin, so a Money page's ink
/// button and its outline alternative stand at one width.
struct MoneyChoiceStack<Content: View>: View {
    @ViewBuilder let content: () -> Content

    @Environment(\.moneyInset) private var inset

    var body: some View {
        KitChoiceStack { content() }
            // The stack carries the margin, so what is inside draws none.
            .environment(\.moneyInset, 0)
            .padding(.horizontal, inset)
            .padding(.vertical, 8)
    }
}

// MARK: - Sheets

/// ONE ROW OF A SHEET OF CHOICES: an optional mark, a verb, its detail under it,
/// and a check when it is the current one. 44pt, the whole row the target.
struct MoneySheetRow: View {
    var iconKey: String = ""
    let label: String
    var detail: String = ""
    var selected: Bool = false
    var destructive: Bool = false
    /// A category's dot: its list-palette key, or empty for the dashed "no category" dot.
    /// `nil` draws none.
    var dot: String? = nil
    let identifier: String
    let onTap: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let ink = destructive ? "net" : "text"
        Button(action: onTap) {
            HStack(spacing: 12) {
                if let dot {
                    if dot.isEmpty {
                        Circle()
                            .strokeBorder(Surface.meta, style: StrokeStyle(lineWidth: 1.2, dash: [2, 2]))
                            .frame(width: 10, height: 10)
                    } else {
                        Circle().fill(docsListColor(dot)).frame(width: 10, height: 10)
                    }
                }
                if !iconKey.isEmpty {
                    CentraidIconView(iconKey: iconKey, tint: Theme.color(ink, scheme), size: 18)
                        .frame(width: 24, height: 24)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(label)
                        .centraidType("body")
                        .foregroundStyle(Theme.color(ink, scheme))
                        .lineLimit(2)
                    if !detail.isEmpty {
                        Text(detail)
                            .centraidType("annotLabel")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
                if selected {
                    CentraidIconView(iconKey: "Check", tint: AppAccent("money").text, size: 16)
                }
            }
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }
}

/// A SHEET OF CHOICES that scrolls: a month, an account, a category, a merge target. Choices
/// that name a group (the category picker) stand in a card per group under its capitals heading;
/// a category wears its colour as a dot, "No category" the dashed one.
struct MoneyChoiceSheet: View {
    let title: String
    let choices: [Centraid_Core_V1_MoneyChoice]
    let identifierPrefix: String
    let onPick: (String) -> Void

    /// A picker of categories: any choice with a colour, or the first (the "No category" row)
    /// ahead of grouped ones.
    private var hasDots: Bool {
        choices.contains { !$0.colorKey.isEmpty } && choices.contains { !$0.detail.isEmpty }
    }

    /// The choices as runs sharing one group name, in order; the first run is the ungrouped lead.
    private var runs: [(group: String, items: [Centraid_Core_V1_MoneyChoice])] {
        var out: [(group: String, items: [Centraid_Core_V1_MoneyChoice])] = []
        for choice in choices {
            if let last = out.last, last.group == choice.detail {
                out[out.count - 1].items.append(choice)
            } else {
                out.append((group: choice.detail, items: [choice]))
            }
        }
        return out
    }

    var body: some View {
        SheetRoom(title: title) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if hasDots {
                        ForEach(Array(runs.enumerated()), id: \.offset) { _, run in
                            if !run.group.isEmpty {
                                Text(run.group)
                                    .kitType(.group)
                                    .foregroundStyle(Surface.meta)
                                    .padding(.horizontal, 4)
                                    .padding(.top, 14)
                                    .padding(.bottom, 4)
                                    .accessibilityAddTraits(.isHeader)
                            }
                            VStack(spacing: 0) {
                                ForEach(Array(run.items.enumerated()), id: \.offset) { index, choice in
                                    if index > 0 { KitHairline(inset: 16) }
                                    row(choice).padding(.horizontal, 16)
                                }
                            }
                            .background(Surface.sheetCard, in: RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
                        }
                    } else {
                        ForEach(Array(choices.enumerated()), id: \.offset) { _, choice in
                            row(choice)
                        }
                    }
                }
            }
        }
    }

    private func row(_ choice: Centraid_Core_V1_MoneyChoice) -> some View {
        MoneySheetRow(
            label: choice.label,
            detail: hasDots ? "" : choice.detail,
            selected: choice.selected,
            dot: hasDots ? choice.colorKey : nil,
            identifier: "\(identifierPrefix)-\(choice.key)"
        ) { onPick(choice.key) }
    }
}

/// A SHEET THAT HOLDS A FORM: the room, its fields in a scroll, no side gutter of the rows' own.
struct MoneyFormSheet<Content: View>: View {
    let title: String
    var status: String = ""
    var primary: SheetPrimary? = nil
    let content: () -> Content

    init(
        title: String,
        status: String = "",
        primary: SheetPrimary? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.status = status
        self.primary = primary
        self.content = content
    }

    var body: some View {
        SheetRoom(title: title, status: status, primary: primary) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) { content() }
            }
        }
        .environment(\.moneyInset, 0)
    }
}

// MARK: - The page's foot

/// THE STATUS LINE a pushed page hosts at its foot (product-intuition/references/design-behaviour.md § Status line).
struct MoneyStatusFoot: View {
    let status: Centraid_Core_V1_StatusLine
    var identifier: String = "money-status"

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if !status.sentence.isEmpty {
            StatusLineView(status: status, identifier: identifier) {}
                .padding(.vertical, 4)
                .background(Theme.color("bg", scheme))
        }
    }
}

// MARK: - Figures laid across, the category table and the cash-flow chart





/// THE CASH-FLOW CHART: a pair of bars per month, In and Out, from the state's
/// own heights (`in_bp` and `out_bp`, basis points of the series' largest side
/// — nothing is measured here). A month that is not over is outlined, never
/// filled, so it cannot be read as a whole month.
struct MoneyCashflowChart: View {
    let months: [Centraid_Core_V1_MoneyCashflowMonth]
    let summary: String

    @Environment(\.colorScheme) private var scheme
    @Environment(\.moneyInset) private var inset

    private let plotHeight: CGFloat = 132

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .bottom, spacing: 4) {
                ForEach(Array(months.enumerated()), id: \.offset) { _, month in
                    VStack(spacing: 4) {
                        HStack(alignment: .bottom, spacing: 2) {
                            bar(month.inBp, ink: "textSoft", partial: month.partial)
                            bar(month.outBp, ink: "textGhost", partial: month.partial)
                        }
                        .frame(height: plotHeight, alignment: .bottom)
                        Text(month.label)
                            .centraidType("eyebrow")
                            .foregroundStyle(Theme.color(month.partial ? "text" : "textFaint", scheme))
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .overlay(alignment: .bottom) {
                KitHairline().offset(y: -22)
            }
        }
        .padding(.horizontal, inset)
        .padding(.top, 8)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(summary)
    }

    @ViewBuilder
    private func bar(_ basisPoints: UInt32, ink: String, partial: Bool) -> some View {
        let height = max(2, plotHeight * CGFloat(min(basisPoints, 10_000)) / 10_000)
        let shape = RoundedRectangle(cornerRadius: Theme.radius("sm", scheme))
        if partial {
            shape.stroke(Theme.color(ink, scheme), lineWidth: 1.5).frame(width: 8, height: height)
        } else {
            shape.fill(Theme.color(ink, scheme)).frame(width: 8, height: height)
        }
    }
}

/// THE CHART'S KEY: a swatch and its word, from copy the state's rows already use.
struct MoneyLegend: View {
    let incoming: String
    let outgoing: String
    let partial: String

    @Environment(\.colorScheme) private var scheme
    @Environment(\.moneyInset) private var inset

    var body: some View {
        HStack(spacing: 16) {
            item(incoming, filled: true, ink: "textSoft")
            item(outgoing, filled: true, ink: "textGhost")
            item(partial, filled: false, ink: "textSoft")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, inset)
        .padding(.top, 8)
        .accessibilityHidden(true)
    }

    private func item(_ text: String, filled: Bool, ink: String) -> some View {
        HStack(spacing: 6) {
            Group {
                if filled {
                    RoundedRectangle(cornerRadius: Theme.radius("sm", scheme)).fill(Theme.color(ink, scheme))
                } else {
                    RoundedRectangle(cornerRadius: Theme.radius("sm", scheme)).stroke(Theme.color(ink, scheme), lineWidth: 1.5)
                }
            }
            .frame(width: 10, height: 10)
            Text(text)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
        }
    }
}

/// A month's row in the table under the chart: its name, then In, Out and Net
/// as three columns.
struct MoneyMonthRow: View {
    let month: Centraid_Core_V1_MoneyCashflowMonth
    let identifier: String

    @Environment(\.colorScheme) private var scheme
    @Environment(\.moneyInset) private var inset

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 0) {
                Text(month.label)
                    .centraidType("body")
                    .foregroundStyle(Theme.color(month.partial ? "textSoft" : "text", scheme))
                let meta = month.meta
                if !meta.isEmpty {
                    Text(meta)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            figure(month.incoming, ink: "text")
            figure(month.outgoing, ink: "text")
            figure(month.net, ink: StatusChipView.ink(month.netTone, neutral: "text"))
        }
        .padding(.horizontal, inset)
        .frame(maxWidth: .infinity, minHeight: 46, alignment: .leading)
        .overlay(alignment: .top) { KitHairline() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(MoneyWords.spoken(month.accessibilityLabel, month.net))
        .accessibilityIdentifier(identifier)
    }

    private func figure(_ money: String, ink: String) -> some View {
        Text(MoneyWords.amount(money))
            .centraidType("annotLabel")
            .monospacedDigit()
            .foregroundStyle(Theme.color(ink, scheme))
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .frame(width: 68, alignment: .trailing)
    }
}


// MARK: - The transaction page


// MARK: - Accounts



// MARK: - Rules



// MARK: - Import review


// MARK: - The kit's look for the pages under Activity (#1173)

/// A white card on a page of cards, with its page margin: the rows inside draw their own 16pt.
struct MoneyPageCard<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(spacing: 0, content: content)
            .environment(\.moneyInset, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .kitCard()
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 6)
    }
}

/// A section label with the kit's group head (12pt capitals). Empty is nothing.
struct MoneySection: View {
    let title: String

    @Environment(\.moneyInset) private var inset

    var body: some View {
        if !title.isEmpty {
            Text(title)
                .kitType(.group)
                .foregroundStyle(Surface.meta)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, inset + 4)
                .padding(.top, 14)
                .padding(.bottom, 2)
                .accessibilityAddTraits(.isHeader)
        }
    }
}

/// A quiet sentence under a section. Empty is nothing. `ink` `net` is the state red.
struct MoneyNote: View {
    let text: String
    var ink: String = "textSoft"

    @Environment(\.moneyInset) private var inset

    var body: some View {
        if !text.isEmpty {
            Text(text)
                .kitType(.meta)
                .foregroundStyle(ink == "net" ? StateColor.red.text : Surface.meta)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, inset + 4)
                .padding(.vertical, 6)
        }
    }
}

/// A heading for a block inside a sheet or a page.
struct MoneyHeading: View {
    let text: String

    @Environment(\.moneyInset) private var inset

    var body: some View {
        if !text.isEmpty {
            Text(text)
                .kitType(.meta)
                .fontWeight(.semibold)
                .foregroundStyle(Surface.body)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, inset)
                .padding(.vertical, 8)
                .accessibilityAddTraits(.isHeader)
        }
    }
}

/// A label beside its figure, inked by the figure's own tone.
struct MoneyFigureRow: View {
    let label: String
    let amount: String
    var positive: Bool = false
    var tone: Centraid_Core_V1_StatusChip.Tone = .neutral

    @Environment(\.moneyInset) private var inset

    init(figure: Centraid_Core_V1_MoneyFigure) {
        self.label = figure.label
        self.amount = figure.amount
        self.positive = figure.positive
        self.tone = figure.tone
    }

    init(label: String, amount: String, tone: Centraid_Core_V1_StatusChip.Tone = .neutral) {
        self.label = label
        self.amount = amount
        self.tone = tone
    }

    var body: some View {
        HStack {
            Text(label)
                .kitType(.row)
                .foregroundStyle(Surface.body)
            Spacer(minLength: 8)
            Text(MoneyWords.amount(amount))
                .kitType(.row)
                .fontWeight(.semibold)
                .monospacedDigit()
                .foregroundStyle(moneyInk(positive: positive, tone: tone))
        }
        .padding(.horizontal, inset)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(MoneyWords.spoken(label, amount))
    }
}

/// A FACT, LABEL OVER VALUE: a fact the member can change is a button with a chevron; the
/// state's own action (`category`, `name`) is what a tap sends. An empty value reads in the
/// amber as the thing still to do.
struct MoneyFactRow: View {
    let label: String
    let value: String
    var owed: Bool = false
    var onTap: (() -> Void)? = nil
    var identifier: String = ""

    @Environment(\.moneyInset) private var inset

    var body: some View {
        if let onTap {
            Button(action: onTap) { row(chevron: true) }
                .buttonStyle(KitRowPress())
                .accessibilityIdentifier(identifier)
        } else {
            row(chevron: false)
        }
    }

    private func row(chevron: Bool) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
                Text(value)
                    .kitType(.row)
                    .foregroundStyle(owed ? StateColor.amber.text : Surface.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if chevron {
                CentraidIconView(iconKey: "ChevronRight", tint: Surface.meta, size: 15)
            }
        }
        .padding(.horizontal, inset)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(MoneyWords.spoken(label + ", " + value))
    }
}

/// NET WORTH ON A CARD: the label, then one amount per currency side by side (never summed) with
/// its code above it, and the state's note under a hairline.
struct MoneyNetWorthCard: View {
    let label: String
    let figures: [Centraid_Core_V1_MoneyFigure]
    let note: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).kitType(.meta).foregroundStyle(Surface.meta)
            HStack(alignment: .top, spacing: 24) {
                ForEach(Array(figures.enumerated()), id: \.offset) { _, figure in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(figure.label).kitType(.meta).foregroundStyle(Surface.meta)
                        Text(MoneyWords.amount(figure.amount))
                            .kitType(.title)
                            .monospacedDigit()
                            .foregroundStyle(Surface.ink)
                            .minimumScaleFactor(0.6)
                            .lineLimit(1)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(MoneyWords.spoken(figure.label, figure.amount))
                }
            }
            if !note.isEmpty {
                KitHairline(inset: 0).padding(.top, 4)
                Text(note).kitType(.meta).foregroundStyle(Surface.meta)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .kitCard()
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.top, 8)
    }
}

/// ONE ACCOUNT: its name and balance, the account's own particulars beneath, and the statement
/// check as its own line: a tick when the books agree, an alert with the difference when they do
/// not (amber), plain words when there is no statement balance yet. The tone is the state's.
struct MoneyAccountRowView: View {
    let row: Centraid_Core_V1_MoneyAccountRow
    let onTap: () -> Void

    @Environment(\.moneyInset) private var inset

    private var checkLine: String {
        row.hasDelta_p ? MoneyWords.meta(MoneyWords.amount(row.delta) + " " + row.checkpointLine) : row.checkpointLine
    }

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(row.name)
                        .kitType(.row)
                        .fontWeight(.semibold)
                        .foregroundStyle(Surface.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(row.hasBalance_p ? MoneyWords.amount(row.balance) : row.balanceNote)
                        .kitType(.row)
                        .fontWeight(.semibold)
                        .monospacedDigit()
                        .foregroundStyle(Surface.ink)
                        .lineLimit(1)
                }
                if !row.meta.isEmpty {
                    Text(row.meta).kitType(.meta).foregroundStyle(Surface.meta).lineLimit(1)
                }
                if !checkLine.isEmpty {
                    HStack(spacing: 6) {
                        if row.checkpointTone == .warning {
                            CentraidIconView(iconKey: "AlertCircle", tint: StateColor.amber.text, size: 14)
                        }
                        Text(checkLine)
                            .kitType(.meta)
                            .foregroundStyle(row.checkpointTone == .warning ? StateColor.amber.text : Surface.meta)
                            .lineLimit(2)
                    }
                }
            }
            .padding(.horizontal, inset)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(MoneyWords.spoken(row.accessibilityLabel, row.hasBalance_p ? row.balance : nil))
    }
}

/// A ROW THAT OPENS: a title (the rule's pattern, in the mono face), its particulars beneath (up
/// to two lines) and a chevron saying a tap goes somewhere.
struct MoneyChevronRow: View {
    let title: String
    var meta: String = ""
    var mono: Bool = false
    var accessibility: String = ""
    var identifier: String = ""
    let onTap: () -> Void

    @Environment(\.moneyInset) private var inset

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .kitType(.row)
                        .fontWeight(mono ? .semibold : .regular)
                        .foregroundStyle(Surface.ink)
                        .lineLimit(2)
                    if !meta.isEmpty {
                        Text(meta).kitType(.meta).foregroundStyle(Surface.meta).lineLimit(3)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                CentraidIconView(iconKey: "ChevronRight", tint: Surface.meta, size: 15)
            }
            .padding(.horizontal, inset)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibility.isEmpty ? MoneyWords.meta(title, meta) : accessibility)
        .accessibilityIdentifier(identifier)
    }
}

/// WHAT THE NEXT MONTH WILL BE, SAID BEFORE THE MEMBER COMMITS: the label with its note under it
/// and the amount at the trailing edge, on one card.
struct MoneyPreviewCard: View {
    let label: String
    let amount: String
    let note: String

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label).kitType(.meta).foregroundStyle(Surface.meta)
                if !note.isEmpty {
                    Text(note).kitType(.meta).foregroundStyle(Surface.meta)
                }
            }
            Spacer(minLength: 8)
            Text(MoneyWords.amount(amount))
                .kitType(.title)
                .monospacedDigit()
                .foregroundStyle(Surface.ink)
                .minimumScaleFactor(0.6)
                .lineLimit(1)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .kitCard()
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(MoneyWords.spoken(MoneyWords.meta(label, note), amount))
    }
}

/// THE REVIEW'S COUNTS in one strip: New, Already in, Check these, Twice in file, Can't read. A
/// count that asks for the member's eye (Check these amber, Can't read red) wears that state's
/// colour once it is above zero; the state says which (`tone`), so no count is spelled here.
struct MoneyCountTiles: View {
    let counts: [Centraid_Core_V1_MoneyFact]

    var body: some View {
        HStack(alignment: .top, spacing: 4) {
            ForEach(Array(counts.enumerated()), id: \.offset) { _, fact in
                VStack(spacing: 2) {
                    Text(fact.detail)
                        .kitType(.section)
                        .monospacedDigit()
                        .foregroundStyle(ink(fact))
                    Text(fact.label)
                        .kitType(.meta)
                        .foregroundStyle(ink(fact, plain: Surface.meta))
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                        .minimumScaleFactor(0.8)
                }
                .frame(maxWidth: .infinity)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(MoneyWords.meta(fact.label, fact.detail))
            }
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 8)
    }

    private func ink(_ fact: Centraid_Core_V1_MoneyFact, plain: Color = Surface.ink) -> Color {
        switch fact.tone {
        case .net: StateColor.red.text
        case .seam, .warning: StateColor.amber.text
        default: plain
        }
    }
}

/// THE FIGURES OF A SUMMARY SIDE BY SIDE on one card, each a label over its value: a target's
/// six-month average, what is spent so far, what carries in. The state decides the figures.
struct MoneyFigureCard: View {
    let figures: [Centraid_Core_V1_MoneyFigure]

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ForEach(Array(figures.enumerated()), id: \.offset) { _, figure in
                VStack(alignment: .leading, spacing: 4) {
                    Text(figure.label)
                        .kitType(.meta)
                        .foregroundStyle(Surface.meta)
                        .lineLimit(3)
                    Text(MoneyWords.amount(figure.amount))
                        .kitType(.row)
                        .fontWeight(.semibold)
                        .monospacedDigit()
                        .foregroundStyle(moneyInk(positive: figure.positive, tone: figure.tone))
                        .minimumScaleFactor(0.7)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(MoneyWords.spoken(figure.label, figure.amount))
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .kitCard()
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
    }
}

/// A FULL-WIDTH SECONDARY VERB on a pale ground of the app's colour ("Apply to earlier rows").
struct MoneyTintedButton: View {
    let label: String
    let identifier: String
    let action: () -> Void

    @Environment(\.appAccent) private var accent
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: action) {
            Text(label)
                .kitType(.row)
                .fontWeight(.semibold)
                .foregroundStyle(accent.text)
                .frame(maxWidth: .infinity, minHeight: 52)
                .background(accent.wash(dark: scheme == .dark), in: Capsule())
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .accessibilityIdentifier(identifier)
    }
}
