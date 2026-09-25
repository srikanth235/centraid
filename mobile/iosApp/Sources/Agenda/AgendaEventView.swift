import SwiftUI

/// `agenda.event` — one occurrence, with the member's reply, Edit and Cancel
/// (#1046 wave 4), on the kit.
///
/// **THE VIEW DECIDES NOTHING.** Every word, fact, guest, reply choice, action
/// and scope row is on `AgendaEventState`; this file lays them out. Cancel on a
/// one-off asks through the kit's `ConfirmSheet`; on a series the scope sheet
/// IS the confirm, its commit armed only once a scope is picked. `dismissed`
/// (a committed cancellation) and the gone card's action pop; `edit` is an
/// intent `AgendaScreens` routes to the editor.
struct AgendaEventView: View {
    let data: Data
    let send: (Data) -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.openURL) private var openURL

    private var state: Centraid_Screen_V1_AgendaEventState {
        (try? Centraid_Screen_V1_AgendaEventState(serializedBytes: data)) ?? .init()
    }

    private func event(_ build: (inout Centraid_Screen_V1_AgendaEventEvent) -> Void) -> Data {
        tasksEvent(Centraid_Screen_V1_AgendaEventEvent.self, build)
    }

    var body: some View {
        let state = state
        let chrome = state.chrome
        PushedPage(title: chrome.title, parentTitle: chrome.back, onBack: onBack) {
            EmptyView()
        } content: {
            if case let .gone(gone)? = state.content {
                EmptyStateView(headline: gone.title, body: gone.body, actionLabel: gone.actionLabel, onAction: onBack)
                    .accessibilityIdentifier("agenda-event-gone")
            } else {
                ReadStateView(
                    content: readContent(state),
                    loadingLabel: chrome.loading,
                    onRetry: { send(event { $0.refreshed = .init() }) }
                ) { detail in
                    detailView(detail, state: state)
                }
            }
        }
        .sheet(isPresented: Binding(
            get: { state.sheet == .cancelScope },
            set: { open in if !open, state.sheet == .cancelScope { send(event { $0.sheetClosed = .init() }) } }
        )) {
            SheetRoom(
                title: chrome.scopeTitle,
                status: writeSentence(state),
                primary: state.cancelArmed
                    ? SheetPrimary(label: chrome.scopeCommit, destructive: true) { send(event { $0.confirmed = .init() }) }
                    : nil
            ) {
                if !chrome.scopeBody.isEmpty {
                    Text(chrome.scopeBody)
                        .centraidType("body")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }
                AgendaScopeRows(scopes: state.cancelScopes) { scope in
                    send(event { $0.scope = .with { $0.scope = scope } })
                }
                Button { send(event { $0.sheetClosed = .init() }) } label: {
                    Text(chrome.scopeKeep)
                        .centraidType("labelOn")
                        .foregroundStyle(Theme.color("text", scheme))
                        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("agenda-scope-keep")
            }
        }
        .sheet(isPresented: Binding(
            get: { state.hasConfirm },
            set: { open in if !open, state.hasConfirm { send(event { $0.confirmDismissed = .init() }) } }
        )) {
            ConfirmSheet(
                state.confirm,
                cancelLabel: chrome.confirmKeep,
                onConfirm: { send(event { $0.confirmed = .init() }) },
                onDismiss: { send(event { $0.confirmDismissed = .init() }) }
            )
        }
        // A CANCELLATION COMMITTED: the screen is done.
        .onChange(of: state.dismissed) { _, dismissed in
            if dismissed { onBack() }
        }
    }

    private func readContent(_ state: Centraid_Screen_V1_AgendaEventState) -> ScreenContent<Centraid_Screen_V1_AgendaEventData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case .gone?, nil: return .loading(true)
        }
    }

    private func writeSentence(_ state: Centraid_Screen_V1_AgendaEventState) -> String {
        state.write.phase == .refused && state.write.hasFailure ? state.write.failure.sentence : ""
    }

    @ViewBuilder
    private func detailView(_ detail: Centraid_Screen_V1_AgendaEventData, state: Centraid_Screen_V1_AgendaEventState) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if state.hasParked {
                    parkedCard(state.parked)
                }
                header(detail)
                ForEach(Array(detail.facts.enumerated()), id: \.offset) { _, fact in
                    FieldRow(key: fact.label, value: fact.detail)
                }
                // THE JOINING LINK, OPENED BY THE OS under the machine's verb
                // ("Join call"); empty with no link.
                if !detail.callLabel.isEmpty, let url = URL(string: detail.callUri) {
                    HStack {
                        KitOutlineButton(label: detail.callLabel) { openURL(url) }
                            .accessibilityIdentifier("agenda-event-call")
                        Spacer()
                    }
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.top, 12)
                }
                if !detail.notes.isEmpty {
                    Text(detail.notes)
                        .centraidType("reading")
                        .foregroundStyle(Theme.color("text", scheme))
                        .padding(CentraidGeometry.pageMargin)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if detail.hasRsvp {
                    rsvpView(detail.rsvp)
                }
                if !detail.guests.isEmpty {
                    SectionHeader(title: detail.guestHeading)
                    ForEach(detail.guests, id: \.partyID) { guest in
                        guestRow(guest)
                    }
                }
                let sentence = writeSentence(state)
                if !sentence.isEmpty, state.sheet != .cancelScope {
                    Text(sentence)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("net", scheme))
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                        .padding(.top, 12)
                        .accessibilityIdentifier("agenda-event-status")
                }
                VStack(spacing: 8) {
                    ForEach(detail.actions, id: \.key) { action in
                        KitOutlineButton(label: action.label, tone: action.destructive ? "net" : "text") {
                            send(event { $0.action = .with { $0.key = action.key } })
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .disabled(!action.enabled)
                        .opacity(action.enabled ? 1 : 0.5)
                        .accessibilityLabel(action.accessibilityLabel.isEmpty ? action.label : action.accessibilityLabel)
                        .accessibilityIdentifier("agenda-action-\(action.key)")
                    }
                }
                .padding(CentraidGeometry.pageMargin)
            }
        }
        .refreshable { send(event { $0.refreshed = .init() }) }
    }

    private func header(_ detail: Centraid_Screen_V1_AgendaEventData) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(detail.title)
                    .centraidType("title")
                    .foregroundStyle(Theme.color("text", scheme))
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                if detail.hasChip { StatusChipView(detail.chip) }
            }
            Text(detail.dateLabel)
                .centraidType("body")
                .foregroundStyle(Theme.color("text", scheme))
            Text(detail.whenLabel)
                .centraidType("smallStrong")
                .monospacedDigit()
                .foregroundStyle(Theme.color("textSoft", scheme))
            HStack(spacing: 6) {
                Circle()
                    .fill(Theme.color(AgendaHue.role(detail.calendarHueKey), scheme))
                    .frame(width: 8, height: 8)
                Text(detail.calendarName)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
        }
        .padding(CentraidGeometry.pageMargin)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(Theme.color(AgendaHue.role(detail.calendarHueKey), scheme))
                .frame(width: 2)
                .padding(.vertical, 12)
        }
        .opacity(detail.isPast ? 0.7 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(detail.accessibilityLabel)
        .accessibilityIdentifier("agenda-event-head")
    }

    private func rsvpView(_ rsvp: Centraid_Screen_V1_AgendaRsvp) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(rsvp.question)
                .centraidType("smallStrong")
                .foregroundStyle(Theme.color("text", scheme))
            HStack(spacing: 8) {
                ForEach(rsvp.choices, id: \.partstat) { choice in
                    Button {
                        send(event { $0.rsvp = .with { $0.partstat = choice.partstat } })
                    } label: {
                        Text(choice.label)
                            .centraidType("smallStrong")
                            .foregroundStyle(Theme.color(choice.selected ? "onAccent" : "text", scheme))
                            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
                            .background {
                                if choice.selected {
                                    RoundedRectangle(cornerRadius: Theme.radius("md", scheme)).fill(Theme.color("accent", scheme))
                                }
                            }
                            .overlay {
                                if !choice.selected {
                                    RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                                        .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
                                }
                            }
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!choice.enabled)
                    .opacity(choice.enabled ? 1 : 0.5)
                    .accessibilityAddTraits(choice.selected ? .isSelected : [])
                    .accessibilityIdentifier("agenda-rsvp-\(choice.partstat)")
                }
            }
            if !rsvp.note.isEmpty {
                Text(rsvp.note)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textFaint", scheme))
            }
        }
        .padding(CentraidGeometry.pageMargin)
    }

    private func guestRow(_ guest: Centraid_Screen_V1_AgendaGuestRow) -> some View {
        HStack(spacing: 10) {
            Text(guest.initial)
                .centraidType("smallStrong")
                .foregroundStyle(Theme.color("onAccent", scheme))
                .frame(width: 28, height: 28)
                .background(Circle().fill(Theme.color(AgendaHue.role(guest.hueKey), scheme)))
            Text(guest.name)
                .centraidType("body")
                .foregroundStyle(Theme.color("text", scheme))
                .lineLimit(1)
            Spacer(minLength: 8)
            Text(guest.replyLabel)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .frame(minHeight: CentraidGeometry.targetMinCoarse)
        .overlay(alignment: .bottom) { KitHairline() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(guest.accessibilityLabel)
        .accessibilityIdentifier("agenda-guest-\(guest.partyID)")
    }

    private func parkedCard(_ parked: Centraid_Screen_V1_AgendaParkedCard) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(parked.title)
                .centraidType("smallStrong")
                .foregroundStyle(Theme.color("net", scheme))
            if !parked.body.isEmpty {
                Text(parked.body)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
            HStack(spacing: 8) {
                KitOutlineButton(label: parked.retryLabel) { send(event { $0.parkedRetried = .init() }) }
                    .accessibilityIdentifier("agenda-parked-retry")
                KitOutlineButton(label: parked.dismissLabel) { send(event { $0.parkedDismissed = .init() }) }
                    .accessibilityIdentifier("agenda-parked-dismiss")
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                .strokeBorder(Theme.color("net", scheme), lineWidth: CentraidGeometry.hairline)
        )
        .padding(CentraidGeometry.pageMargin)
        .accessibilityIdentifier("agenda-parked")
    }
}

/// A scope sheet's rows — the cancel's and the editor's save. None is
/// pre-chosen; a row that cannot reach that far says why under it.
struct AgendaScopeRows: View {
    let scopes: [Centraid_Screen_V1_AgendaScopeChoice]
    let onPick: (Centraid_Screen_V1_AgendaScope) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(spacing: 0) {
            ForEach(scopes, id: \.scope) { scope in
                VStack(alignment: .leading, spacing: 0) {
                    SheetRow(label: scope.label, selected: scope.selected, identifier: "agenda-scope-\(scope.scope.rawValue)") {
                        onPick(scope.scope)
                    }
                    .disabled(!scope.enabled)
                    .opacity(scope.enabled ? 1 : 0.5)
                    if !scope.note.isEmpty {
                        Text(scope.note)
                            .centraidType("annotLabel")
                            .foregroundStyle(Theme.color("textFaint", scheme))
                            .padding(.bottom, 6)
                    }
                }
            }
        }
    }
}
