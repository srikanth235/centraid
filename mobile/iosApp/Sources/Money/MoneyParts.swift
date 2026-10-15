import SwiftProtobuf
import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif

// MONEY'S SHARED DRAWING PARTS (#1099).
//
// Every word here is the state's. An amount is the vault's `Money{minor,
// currency, exponent}` drawn by the kit's one formatter (`Kit/Money.swift`) at
// the state's own exponent; nothing here adds two amounts, picks a sign, a tone
// or a currency. The twin of Android's `screens/money/MoneyParts.kt`.

/// One Money event, encoded: the bytes every Money bridge takes.
func moneyEvent<Event: SwiftProtobuf.Message>(_ type: Event.Type, _ build: (inout Event) -> Void) -> Data {
    var event = Event()
    build(&event)
    return event.encoded
}

/// The words a view assembles from the state's own: a rendered amount, a spoken
/// phrase, a refusal's sentence. Nothing decided, only joined.
enum MoneyWords {
    /// Money as the vault says to render it; absent is nothing.
    static func amount(_ money: Centraid_Screen_V1_Money) -> String { Money.render(money) }

    /// The state's words, then the rendered money after them.
    static func spoken(_ words: String, _ money: Centraid_Screen_V1_Money? = nil) -> String {
        [words, money.map { Money.render($0) } ?? ""].filter { !$0.isEmpty }.joined(separator: ", ")
    }

    /// Two clauses of one meta line.
    static func meta(_ parts: String...) -> String {
        parts.filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
    }

    /// A write refusal's sentence, for a page's status host.
    static func refusal(_ write: Centraid_Screen_V1_WriteState) -> String {
        write.phase == .refused ? write.failure.sentence : ""
    }

    /// The one status line a page hosts: the machine's own, else a refused write's sentence.
    static func line(
        _ status: Centraid_Screen_V1_StatusLine?,
        write: Centraid_Screen_V1_WriteState? = nil
    ) -> Centraid_Screen_V1_StatusLine {
        if let status, !status.sentence.isEmpty { return status }
        var line = Centraid_Screen_V1_StatusLine()
        if let write {
            line.sentence = refusal(write)
            line.refused = true
        }
        return line
    }
}

// MARK: - The read law, per state

extension Centraid_Screen_V1_MoneyHomeState {
    var readContent: ScreenContent<Centraid_Screen_V1_MoneyHomeData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}

extension Centraid_Screen_V1_MoneyTransactionState {
    var readContent: ScreenContent<Centraid_Screen_V1_MoneyTransactionData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}

extension Centraid_Screen_V1_MoneyTargetState {
    var readContent: ScreenContent<Centraid_Screen_V1_MoneyTargetData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}

extension Centraid_Screen_V1_MoneyRecurringState {
    var readContent: ScreenContent<Centraid_Screen_V1_MoneyRecurringData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}

extension Centraid_Screen_V1_MoneyImportState {
    var readContent: ScreenContent<Centraid_Screen_V1_MoneyImportData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}

extension Centraid_Screen_V1_MoneyAccountsState {
    var readContent: ScreenContent<Centraid_Screen_V1_MoneyAccountsData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}

extension Centraid_Screen_V1_MoneyRulesState {
    var readContent: ScreenContent<Centraid_Screen_V1_MoneyRulesData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}

extension Centraid_Screen_V1_MoneyCategoriesState {
    var readContent: ScreenContent<Centraid_Screen_V1_MoneyCategoriesData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}

extension Centraid_Screen_V1_MoneySearchState {
    /// `resting` is a fifth arm the search page draws before the read: it is not
    /// a read, so it maps to loading here and the page checks it first.
    var readContent: ScreenContent<Centraid_Screen_V1_MoneySearchData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case .resting?, nil: return .loading(true)
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
func moneySheetBinding(_ open: Bool, close: @escaping () -> Void) -> Binding<Bool> {
    Binding(
        get: { open },
        set: { now in
            guard !now, open else { return }
            close()
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

/// A section label with the kit's header. Empty is nothing.
struct MoneySection: View {
    let title: String

    var body: some View {
        if !title.isEmpty { SectionHeader(title: title) }
    }
}

/// A quiet sentence under a section. Empty is nothing.
struct MoneyNote: View {
    let text: String
    var ink: String = "textSoft"

    @Environment(\.colorScheme) private var scheme
    @Environment(\.moneyInset) private var inset

    var body: some View {
        if !text.isEmpty {
            Text(text)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color(ink, scheme))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, inset)
                .padding(.vertical, 6)
        }
    }
}

/// A heading for a block inside a sheet or a page.
struct MoneyHeading: View {
    let text: String

    @Environment(\.colorScheme) private var scheme
    @Environment(\.moneyInset) private var inset

    var body: some View {
        if !text.isEmpty {
            Text(text)
                .centraidType("smallStrong")
                .foregroundStyle(Theme.color("textSoft", scheme))
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
    let amount: Centraid_Screen_V1_Money
    var tone: Centraid_Screen_V1_StatusChip.Tone = .neutral

    @Environment(\.colorScheme) private var scheme

    init(figure: Centraid_Screen_V1_MoneyFigure) {
        self.label = figure.label
        self.amount = figure.amount
        self.tone = figure.tone
    }

    init(label: String, amount: Centraid_Screen_V1_Money, tone: Centraid_Screen_V1_StatusChip.Tone = .neutral) {
        self.label = label
        self.amount = amount
        self.tone = tone
    }

    var body: some View {
        HStack {
            Text(label)
                .centraidType("body")
                .foregroundStyle(Theme.color("textSoft", scheme))
            Spacer(minLength: 8)
            Text(MoneyWords.amount(amount))
                .centraidType("mono")
                .monospacedDigit()
                .foregroundStyle(Theme.color(StatusChipView.ink(tone, neutral: "text"), scheme))
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(MoneyWords.spoken(label, amount))
    }
}

// MARK: - The hero

/// THE HERO: one display figure per currency, the sentence under it, and the
/// bar when a plan is set. The bar is spent against plan; the tick is how far
/// through the month today falls. Over plan reads as the `net` ink and the
/// figure's own minus sign: colour is the second channel.
struct MoneyHeroView: View {
    let hero: Centraid_Screen_V1_MoneyHero

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                Text(MoneyWords.amount(hero.spent))
                    .centraidType("display")
                    .foregroundStyle(Theme.color(hero.over ? "net" : "text", scheme))
                    .accessibilityLabel(MoneyWords.spoken(hero.spentLabel, hero.spent))
                Text(hero.spentLabel)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .accessibilityHidden(true)
                if hero.hasBar_p {
                    MoneyBar(fillBp: hero.fillBp, tickBp: hero.tickBp, over: hero.over, spoken: hero.accessibilityLabel)
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("money-hero")
            ForEach(Array(hero.figures.enumerated()), id: \.offset) { _, figure in
                MoneyFigureRow(figure: figure)
            }
        }
    }
}

/// A plan bar from the state's basis points: the fill, and a tick for the day.
struct MoneyBar: View {
    let fillBp: UInt32
    let tickBp: UInt32
    let over: Bool
    let spoken: String

    @Environment(\.colorScheme) private var scheme

    private static let basis: Double = 10_000
    private static let tickWidth: Double = 0.006

    private func fraction(_ bp: UInt32) -> Double { Double(min(bp, 10_000)) / Self.basis }

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            ZStack(alignment: .leading) {
                Rectangle().fill(Theme.color("bgSunken", scheme))
                Rectangle()
                    .fill(Theme.color(over ? "net" : "textSoft", scheme))
                    .frame(width: width * fraction(fillBp))
                if tickBp > 0 {
                    Rectangle()
                        .fill(Theme.color("text", scheme))
                        .frame(width: width * Self.tickWidth)
                        .offset(x: min(width * fraction(tickBp), width * (1 - Self.tickWidth)))
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius("sm", scheme)))
        }
        .frame(height: 6)
        .padding(.top, 10)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
    }
}

// MARK: - Rows

/// THE TRANSACTION ROW: the one row, the signed amount as its figure.
struct MoneyRowView: View {
    let row: Centraid_Screen_V1_MoneyRow
    var onTap: (() -> Void)? = nil

    var body: some View {
        CentraidRow(
            title: row.title,
            meta: MoneyWords.meta(row.categoryLabel, row.meta),
            trailing: MoneyWords.amount(row.amount),
            trailingTone: StatusChipView.ink(row.amountTone, neutral: "text"),
            chips: row.chips,
            dimmed: row.dimmed,
            accessibility: MoneyWords.spoken(row.accessibilityLabel, row.amount),
            identifier: "money-row-\(row.txnID)",
            onTap: onTap
        )
    }
}

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
                .centraidType("body")
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
    let choices: [Centraid_Screen_V1_MoneyChoice]
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

    var body: some View {
        KitInkButton(label: label, destructive: destructive, identifier: identifier, action: action)
            .disabled(!enabled)
            .padding(.horizontal, inset)
            .padding(.vertical, 8)
    }
}

/// A SECONDARY VERB, padded to the gutter. `tone` is an ink role (`net` for a removal).
struct MoneyQuietButton: View {
    let label: String
    var tone: String = "text"
    let identifier: String
    let action: () -> Void

    @Environment(\.moneyInset) private var inset

    var body: some View {
        HStack {
            KitOutlineButton(label: label, tone: tone, action: action)
                .accessibilityIdentifier(identifier)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, inset)
        .padding(.vertical, 6)
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
    let identifier: String
    let onTap: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let ink = destructive ? "net" : "text"
        Button(action: onTap) {
            HStack(spacing: 12) {
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
                    CentraidIconView(iconKey: "Check", tint: Theme.color("text", scheme), size: 16)
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

/// A SHEET OF CHOICES that scrolls: a month, an account, a category, a merge target.
struct MoneyChoiceSheet: View {
    let title: String
    let choices: [Centraid_Screen_V1_MoneyChoice]
    let identifierPrefix: String
    let onPick: (String) -> Void

    var body: some View {
        SheetRoom(title: title) {
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(Array(choices.enumerated()), id: \.offset) { _, choice in
                        MoneySheetRow(
                            label: choice.label,
                            detail: choice.detail,
                            selected: choice.selected,
                            identifier: "\(identifierPrefix)-\(choice.key)"
                        ) { onPick(choice.key) }
                    }
                }
            }
        }
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

/// THE STATUS LINE a pushed page hosts at its foot (DESIGN.md: no toast).
struct MoneyStatusFoot: View {
    let status: Centraid_Screen_V1_StatusLine
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
