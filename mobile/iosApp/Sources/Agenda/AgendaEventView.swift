import SwiftUI

/// `agenda.event` — one occurrence, with the member's reply, Edit and Cancel
/// (#1135), on the kit.
///
/// **THE VIEW DECIDES NOTHING.** Every word, fact, guest, reply choice, action
/// and scope row is on `AgendaEventState`, made in Rust; this file lays them out. Cancel on a
/// one-off asks through the kit's `ConfirmSheet`; on a series the scope sheet
/// IS the confirm, its commit armed only once a scope is picked. `dismissed`
/// (a committed cancellation) and the gone card's action pop; `edit` carries a
/// `route` to the editor, which the shell pushes.
struct AgendaEventView: View {
    let state: Centraid_Core_V1_AgendaEventState
    let send: (Centraid_Core_V1_AgendaEventEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.openURL) private var openURL

    private func event(_ build: (inout Centraid_Core_V1_AgendaEventEvent) -> Void) -> Centraid_Core_V1_AgendaEventEvent {
        var event = Centraid_Core_V1_AgendaEventEvent()
        build(&event)
        return event
    }

    var body: some View {
        let chrome = state.chrome
        // THE EVENT'S OWN NAME IS THE LARGE TITLE (#1173): the bar carries only the chevron.
        PushedPage(title: "", parentTitle: chrome.back, onBack: onBack) {
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

    private func readContent(_ state: Centraid_Core_V1_AgendaEventState) -> ScreenContent<Centraid_Core_V1_AgendaEventData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .gated(denied)
        case let .data(data)?: return .data(data)
        case .gone?, nil: return .loading(true)
        }
    }

    /// What the last write came to when the vault refused it: the core's own sentence.
    private func writeSentence(_ state: Centraid_Core_V1_AgendaEventState) -> String {
        state.hasStatus ? state.status.sentence : ""
    }

    @ViewBuilder
    private func detailView(_ detail: Centraid_Core_V1_AgendaEventData, state: Centraid_Core_V1_AgendaEventState) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header(detail)
                // THE FACTS IN ONE ROUNDED CARD (#1173), label left and value right, as on the board.
                if !detail.facts.isEmpty {
                    AgendaGroupCard {
                        ForEach(Array(detail.facts.enumerated()), id: \.offset) { index, fact in
                            AgendaFactRow(label: fact.label, value: fact.detail, divider: index < detail.facts.count - 1)
                        }
                    }
                    .accessibilityIdentifier("agenda-event-facts")
                }
                // THE JOINING LINK, OPENED BY THE OS under Rust's verb
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
                    AgendaGroupCard {
                        ForEach(Array(detail.guests.enumerated()), id: \.element.partyID) { index, guest in
                            guestRow(guest, last: index == detail.guests.count - 1)
                        }
                    }
                    .padding(.top, 0)
                }
                // GUESTS THE PHONE'S CALENDAR HOLDS, read only: a name (else the address), the address
                // under a name, and the guest's answer.
                if !detail.followedGuests.isEmpty {
                    SectionHeader(title: detail.followedHeading)
                        .accessibilityIdentifier("agenda-event-followed")
                    ForEach(Array(detail.followedGuests.enumerated()), id: \.offset) { index, guest in
                        followedRow(guest, index: index)
                    }
                }
                if detail.hasAttachments {
                    AgendaAttachmentsView(
                        section: detail.attachments,
                        idPrefix: "agenda-event-attachment",
                        headIdentifier: "agenda-event-attachments",
                        open: open,
                        send: { attachment in send(event { $0.attachment = attachment }) }
                    )
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
                // THE ACTIONS IN ONE ROW OF EQUAL KEYS (#1173): Open in Maps, Edit and Cancel share
                // the width, Cancel in the red outline.
                KitChoiceRow {
                    ForEach(detail.actions, id: \.key) { action in
                        KitOutlineButton(label: action.label, tone: action.destructive ? "net" : "text") {
                            // `edit` opens the editor on this occurrence (a route the shell
                            // pushes); `cancel` is the event that asks first.
                            if action.hasRoute {
                                open(action.route)
                            } else {
                                send(event { $0.action = .with { $0.key = action.key } })
                            }
                        }
                        .disabled(!action.enabled)
                        .accessibilityLabel(action.accessibilityLabel.isEmpty ? action.label : action.accessibilityLabel)
                        .accessibilityIdentifier("agenda-action-\(action.key)")
                    }
                }
                .padding(CentraidGeometry.pageMargin)
            }
        }
        .refreshable { send(event { $0.refreshed = .init() }) }
    }

    private func header(_ detail: Centraid_Core_V1_AgendaEventData) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(detail.title)
                    .kitType(.title)
                    .foregroundStyle(detail.isPast ? Surface.meta : Surface.ink)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
            }
            Text(detail.dateLabel)
                .centraidType("body")
                .foregroundStyle(Theme.color(detail.isPast ? "textSoft" : "text", scheme))
            Text(detail.whenLabel)
                .centraidType("smallStrong")
                .monospacedDigit()
                .foregroundStyle(Theme.color(detail.isPast ? "textFaint" : "textSoft", scheme))
            HStack(spacing: 6) {
                Circle()
                    .fill(agendaHue(detail.calendarHueKey, scheme))
                    .frame(width: 8, height: 8)
                Text(detail.calendarName)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
        }
        .padding(CentraidGeometry.pageMargin)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(detail.accessibilityLabel)
        .accessibilityIdentifier("agenda-event-head")
    }

    private func rsvpView(_ rsvp: Centraid_Core_V1_AgendaRsvp) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(rsvp.question)
                .centraidType("smallStrong")
                .foregroundStyle(Theme.color("text", scheme))
            // THE BOARD'S THREE EQUAL KEYS: Going, Maybe, Not going share the width, the
            // answer given filled in Agenda's blue, the others a plain capsule.
            HStack(spacing: 8) {
                ForEach(rsvp.choices, id: \.partstat) { choice in
                    Button {
                        send(event { $0.rsvp = .with { $0.partstat = choice.partstat } })
                    } label: {
                        Text(choice.label)
                            .centraidType(choice.selected ? "smallStrong" : "small")
                            .foregroundStyle(choice.selected ? Color.white : Theme.color(choice.enabled ? "text" : "textDisabled", scheme))
                            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
                            .background {
                                if choice.selected {
                                    Capsule().fill(AppAccent("agenda").fill)
                                } else {
                                    Capsule().fill(Surface.card)
                                    Capsule().strokeBorder(Surface.line, lineWidth: CentraidGeometry.hairline)
                                }
                            }
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(!choice.enabled)
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

    private func followedRow(_ guest: Centraid_Core_V1_AgendaFollowedGuestRow, index: Int) -> some View {
        HStack(spacing: 10) {
            Text(guest.initial)
                .centraidType("smallStrong")
                .foregroundStyle(Theme.color("onAccent", scheme))
                .frame(width: 28, height: 28)
                .background(Circle().fill(Theme.color(KitHue.role(guest.hueKey) ?? "cSlate", scheme)))
            VStack(alignment: .leading, spacing: 0) {
                Text(guest.name)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("text", scheme))
                    .lineLimit(1)
                if !guest.detail.isEmpty {
                    Text(guest.detail)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                        .lineLimit(1)
                }
            }
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
        .accessibilityIdentifier("agenda-event-followed-guest-\(index)")
    }

    private func guestRow(_ guest: Centraid_Core_V1_AgendaGuestRow, last: Bool) -> some View {
        HStack(spacing: 10) {
            Text(guest.initial)
                .centraidType("smallStrong")
                .foregroundStyle(Theme.color("onAccent", scheme))
                .frame(width: 28, height: 28)
                .background(Circle().fill(Theme.color(KitHue.role(guest.hueKey) ?? "cSlate", scheme)))
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
        // A HAIRLINE BETWEEN GUESTS, NONE UNDER THE LAST: it would draw along the card's rounded foot.
        .overlay(alignment: .bottom) { if !last { KitHairline() } }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(guest.accessibilityLabel)
        .accessibilityIdentifier("agenda-guest-\(guest.partyID)")
    }
}

/// A scope sheet's rows — the cancel's and the editor's save. None is
/// pre-chosen; a row that cannot reach that far says why under it.
struct AgendaScopeRows: View {
    let scopes: [Centraid_Core_V1_AgendaScopeChoice]
    let onPick: (Centraid_Core_V1_AgendaScope) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(spacing: 0) {
            ForEach(scopes, id: \.scope) { scope in
                VStack(alignment: .leading, spacing: 0) {
                    SheetRow(label: scope.label, selected: scope.selected, identifier: "agenda-scope-\(scope.scope.rawValue)") {
                        onPick(scope.scope)
                    }
                    .disabled(!scope.enabled)
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
