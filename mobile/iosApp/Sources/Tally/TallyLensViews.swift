import SwiftUI

// TALLY'S LENSES — recurring, spending, search (#1046). Read-only pages off
// the More sheet; each is a `PushedPage` over `ReadStateView`.

// MARK: - Recurring

struct TallyRecurringView: View {
    let data: Data
    let send: (Data) -> Void
    let onBack: () -> Void

    private var state: Centraid_Screen_V1_TallyRecurringState {
        (try? Centraid_Screen_V1_TallyRecurringState(serializedBytes: data)) ?? .init()
    }

    private static func refreshed() -> Data {
        Centraid_Screen_V1_TallyRecurringEvent.with { $0.refreshed = .init() }.encoded
    }

    private func content(_ state: Centraid_Screen_V1_TallyRecurringState) -> ScreenContent<Centraid_Screen_V1_TallyRecurringData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }

    var body: some View {
        let state = state
        PushedPage(title: state.title, parentTitle: state.chrome.back, onBack: onBack) {
            EmptyView()
        } content: {
            ReadStateView(
                content: content(state),
                loadingLabel: state.chrome.loading,
                onRetry: { send(Self.refreshed()) }
            ) { recurring in
                if recurring.hasEmpty {
                    EmptyStateView(recurring.empty)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(recurring.templates, id: \.templateID) { template in
                                CentraidRow(
                                    title: template.title,
                                    meta: [template.schedule, template.meta].filter { !$0.isEmpty }.joined(separator: " · "),
                                    trailing: tallyMoney(template.amount),
                                    chip: template.hasStatus && !template.status.label.isEmpty ? template.status : nil,
                                    accessibility: "\(template.accessibilityLabel), \(tallyMoney(template.amount))",
                                    identifier: "tally-template-\(template.templateID)"
                                )
                            }
                        }
                    }
                    .refreshable { send(Self.refreshed()) }
                }
            }
        }
    }
}

// MARK: - Spending

struct TallySpendingView: View {
    let data: Data
    let parentTitle: String
    let send: (Data) -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_TallySpendingState {
        (try? Centraid_Screen_V1_TallySpendingState(serializedBytes: data)) ?? .init()
    }

    static func event(_ build: (inout Centraid_Screen_V1_TallySpendingEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_TallySpendingEvent()
        build(&event)
        return event.encoded
    }

    private func content(_ state: Centraid_Screen_V1_TallySpendingState) -> ScreenContent<Centraid_Screen_V1_TallySpendingData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }

    var body: some View {
        let state = state
        PushedPage(title: state.chrome.title, parentTitle: parentTitle, onBack: onBack) {
            EmptyView()
        } content: {
            VStack(spacing: 0) {
                stepper(state)
                ReadStateView(
                    content: content(state),
                    loadingLabel: state.chrome.loading,
                    onRetry: { send(Self.event { $0.refreshed = .init() }) }
                ) { spending in
                    if spending.hasEmpty {
                        EmptyStateView(spending.empty)
                    } else {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 0) {
                                ForEach(spending.currencies, id: \.currency) { currency in
                                    currencyBlock(currency)
                                }
                                TallyNote(text: spending.note)
                            }
                            .padding(.bottom, 16)
                        }
                        .refreshable { send(Self.event { $0.refreshed = .init() }) }
                    }
                }
            }
        }
    }

    private func stepper(_ state: Centraid_Screen_V1_TallySpendingState) -> some View {
        HStack(spacing: 8) {
            step("ChevronLeft", state.chrome.previous, -1, enabled: state.previousEnabled, "tally-month-previous")
            Text(state.monthLabel)
                .centraidType("title")
                .foregroundStyle(Theme.color("text", scheme))
                .frame(maxWidth: .infinity)
                .accessibilityAddTraits(.isHeader)
            step("ChevronRight", state.chrome.next, 1, enabled: state.nextEnabled, "tally-month-next")
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
    }

    private func step(_ icon: String, _ label: String, _ months: Int32, enabled: Bool, _ identifier: String) -> some View {
        Button {
            send(Self.event { $0.monthStepped = .with { $0.months = months } })
        } label: {
            CentraidIconView(iconKey: icon, tint: Theme.color(enabled ? "text" : "textFaint", scheme), size: 16)
                .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.radius("sm", scheme))
                        .strokeBorder(Theme.color("line", scheme), lineWidth: CentraidGeometry.hairline)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }

    @ViewBuilder
    private func currencyBlock(_ currency: Centraid_Screen_V1_TallyCurrencySpend) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(currency.currency)
                .centraidType("eyebrow")
                .foregroundStyle(Theme.color("textSoft", scheme))
                .accessibilityAddTraits(.isHeader)
            Text(tallyMoney(currency.total))
                .centraidType("display")
                .monospacedDigit()
                .foregroundStyle(Theme.color("text", scheme))
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.top, 16)
        .padding(.bottom, 4)
        ForEach(Array(currency.facts.enumerated()), id: \.offset) { _, fact in
            FieldRow(key: fact.label, value: tallyMoney(fact.amount), note: fact.note)
        }
        ForEach(currency.categories, id: \.category) { category in
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 12) {
                    CentraidIconView(iconKey: category.iconKey, tint: Theme.color("textSoft", scheme), size: 18)
                        .frame(width: 24, height: 24)
                        .accessibilityHidden(true)
                    Text(category.label)
                        .centraidType("body")
                        .foregroundStyle(Theme.color("text", scheme))
                    Spacer(minLength: 8)
                    Text(tallyMoney(category.total))
                        .centraidType("smallStrong")
                        .monospacedDigit()
                        .foregroundStyle(Theme.color("text", scheme))
                }
                // The proportion bar: the state's per-mille, drawn.
                GeometryReader { proxy in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Theme.color("bgSunken", scheme))
                        Capsule()
                            .fill(Theme.color("textSoft", scheme))
                            .frame(width: proxy.size.width * CGFloat(min(category.sharePermille, 1000)) / 1000)
                    }
                }
                .frame(height: 4)
                .padding(.leading, 36)
                .accessibilityHidden(true)
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 8)
            .overlay(alignment: .bottom) { KitHairline() }
            .accessibilityElement(children: .combine)
        }
    }
}

// MARK: - Search

struct TallySearchView: View {
    let data: Data
    let parentTitle: String
    let send: (Data) -> Void
    let push: (ShellModel.Route) -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_TallySearchState {
        (try? Centraid_Screen_V1_TallySearchState(serializedBytes: data)) ?? .init()
    }

    static func event(_ build: (inout Centraid_Screen_V1_TallySearchEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_TallySearchEvent()
        build(&event)
        return event.encoded
    }

    /// Resting is its own sentence, drawn as the data case's empty.
    private enum Found {
        case resting(Centraid_Screen_V1_EmptyState)
        case results(Centraid_Screen_V1_TallySearchData)
    }

    private func content(_ state: Centraid_Screen_V1_TallySearchState) -> ScreenContent<Found> {
        switch state.content {
        case let .resting(empty)?: return .data(.resting(empty))
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(.results(data))
        case nil: return .loading(true)
        }
    }

    var body: some View {
        let state = state
        PushedPage(title: state.chrome.title, parentTitle: parentTitle, onBack: onBack) {
            EmptyView()
        } content: {
            VStack(spacing: 0) {
                CentraidSearchField(
                    field: state.field,
                    placeholder: state.chrome.placeholder,
                    closeLabel: state.chrome.close,
                    identifier: "tally-search",
                    onTerm: { term in send(Self.event { $0.term = .with { $0.term = term } }) },
                    onClose: { send(Self.event { $0.cleared = .init() }) }
                )
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.vertical, 8)
                ReadStateView(
                    content: content(state),
                    loadingLabel: state.chrome.loading,
                    onRetry: { send(Self.event { $0.refreshed = .init() }) }
                ) { found in
                    switch found {
                    case let .resting(empty):
                        EmptyStateView(empty)
                    case let .results(results):
                        if results.hasEmpty {
                            EmptyStateView(results.empty)
                        } else {
                            ScrollView {
                                LazyVStack(alignment: .leading, spacing: 0) {
                                    TallyNote(text: results.countLabel)
                                    ForEach(results.results, id: \.rowKey) { row in
                                        TallyLedgerRowView(row: row) {
                                            guard !row.expenseID.isEmpty else { return }
                                            send(Self.event { $0.expense = .with { $0.expenseID = row.expenseID } })
                                            push(TallyScreens.expenseRoute(row.expenseID))
                                        }
                                    }
                                }
                            }
                            .scrollDismissesKeyboard(.interactively)
                        }
                    }
                }
            }
        }
    }
}
