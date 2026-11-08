import SwiftUI

// THE FOUR READ SHAPES, DRAWN ONCE (K5; product-intuition/references/design-behaviour.md § Rooms).
//
// The room owns the empty, loading and error states; the app supplies the
// words. A screen that draws its own spinner, its own failure lines or its own
// "nothing here" is a finding, so every list screen switches on its content
// through `ReadStateView` and nowhere else.

/// The one switch over a screen's `ScreenContent`.
///
/// Loading draws the skeleton the caller names (rows at row geometry by
/// default, never a spinner); a failure draws its sentence, its remedy and a
/// member-initiated Retry — the machines never retry on their own; a denial
/// draws the gate with its receipt; data draws the caller's content.
struct ReadStateView<Value, Skeleton: View, Content: View>: View {
    let content: ScreenContent<Value>
    let skeleton: () -> Skeleton
    let onRetry: (() -> Void)?
    let retryLabel: String
    let data: (Value) -> Content

    init(
        content: ScreenContent<Value>,
        @ViewBuilder skeleton: @escaping () -> Skeleton,
        onRetry: (() -> Void)?,
        retryLabel: String = KitWords.RETRY,
        @ViewBuilder data: @escaping (Value) -> Content
    ) {
        self.content = content
        self.skeleton = skeleton
        self.onRetry = onRetry
        self.retryLabel = retryLabel
        self.data = data
    }

    var body: some View {
        switch content {
        case .loading:
            skeleton()
        case let .failure(sentence, remedy):
            FailureView(sentence: sentence, remedy: remedy, retryLabel: retryLabel, onRetry: onRetry)
        case let .denied(denied):
            DeniedGate(denied)
        case let .data(value):
            data(value)
        }
    }
}

extension ReadStateView where Skeleton == RowSkeleton {
    /// The common case: a list, so its skeleton is rows.
    init(
        content: ScreenContent<Value>,
        loadingLabel: String = KitWords.OPENING,
        onRetry: (() -> Void)?,
        retryLabel: String = KitWords.RETRY,
        @ViewBuilder data: @escaping (Value) -> Content
    ) {
        self.init(
            content: content,
            skeleton: { RowSkeleton(label: loadingLabel) },
            onRetry: onRetry,
            retryLabel: retryLabel,
            data: data
        )
    }
}

/// SKELETONS AT ROW GEOMETRY — the handoff's word, and the reason there is no
/// `ProgressView` in a kit screen.
///
/// Static: a shimmer is motion a member did not ask for. The bars are the `skel`
/// role at the height `CentraidRow` draws (44pt minimum), so the list that
/// arrives lands where the skeleton stood rather than jumping. One element to
/// a screen reader, which hears "Opening" and not eight empty rows.
struct RowSkeleton: View {
    var rows: Int = 8
    var meta: Bool = true
    var label: String = KitWords.OPENING

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(0..<rows, id: \.self) { index in
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        bar(width: index.isMultiple(of: 2) ? 0.62 : 0.48, height: 12)
                        if meta { bar(width: 0.34, height: 9) }
                    }
                    Spacer(minLength: 0)
                    bar(width: 0.16, height: 12)
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .frame(minHeight: meta ? 56 : CentraidGeometry.targetMinCoarse)
                Rectangle()
                    .fill(Theme.color("line", scheme))
                    .frame(height: CentraidGeometry.hairline)
                    .padding(.leading, CentraidGeometry.pageMargin)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityIdentifier("kit-skeleton")
    }

    private func bar(width: CGFloat, height: CGFloat) -> some View {
        GeometryReader { proxy in
            RoundedRectangle(cornerRadius: Theme.radius("sm", scheme))
                .fill(Theme.color("skel", scheme))
                .frame(width: proxy.size.width * width, height: height)
        }
        .frame(height: height)
    }
}

/// A READ THAT WAS REFUSED: its sentence, the remedy a member can act on, and
/// Retry — which sends the screen's own `Refreshed`, because no machine
/// retries a refusal by itself.
struct FailureView: View {
    let sentence: String
    let remedy: String
    var retryLabel: String = KitWords.RETRY
    let onRetry: (() -> Void)?

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(sentence)
                .kitType(.row)
                .foregroundStyle(Surface.ink)
            if !remedy.isEmpty {
                Text(remedy)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
            }
            if let onRetry {
                KitOutlineButton(label: retryLabel, action: onRetry)
                    .accessibilityIdentifier("kit-retry")
                    .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(CentraidGeometry.pageMargin)
        .accessibilityIdentifier("kit-failure")
    }
}

/// The Photos views' name for a failure with no Retry of its own (their
/// machines re-read on the change stream). The kit's view, without the verb.
struct ScreenFailureView: View {
    let sentence: String
    let remedy: String

    var body: some View {
        FailureView(sentence: sentence, remedy: remedy, onRetry: nil)
    }
}

/// NOTHING HERE, AND WHY — one sentence and at most one action (product-intuition/references/design-behaviour.md § Wording
/// copy table). The strings are finished in the machine; the action is the
/// screen's own event, so the view takes a closure.
struct EmptyStateView: View {
    let empty: Centraid_Core_V1_EmptyState
    var onAction: (() -> Void)? = nil
    /// The action's accessibility id; a screen whose action is its own thing
    /// (search's "Ask about") names it.
    var actionIdentifier: String = "kit-empty-action"

    @Environment(\.colorScheme) private var scheme

    init(_ empty: Centraid_Core_V1_EmptyState, actionIdentifier: String = "kit-empty-action", onAction: (() -> Void)? = nil) {
        self.empty = empty
        self.actionIdentifier = actionIdentifier
        self.onAction = onAction
    }

    /// For a screen whose state carries plain strings rather than the kit message.
    init(headline: String, body: String = "", actionLabel: String = "", onAction: (() -> Void)? = nil) {
        var empty = Centraid_Core_V1_EmptyState()
        empty.headline = headline
        empty.body = body
        empty.actionLabel = actionLabel
        self.init(empty, onAction: onAction)
    }

    @Environment(\.appAccent) private var accent

    /// THE EMPTY STATE PATTERN (#1173): a card on the page with the app's glyph on a wash of its
    /// colour, the one sentence, the reason, and at most one action as the app's pill.
    var body: some View {
        VStack(spacing: 10) {
            if let glyph = CentraidCatalog.byID[accent.appId]?.iconKey {
                CentraidIconView(iconKey: glyph, tint: accent.text, size: 22)
                    .frame(width: 52, height: 52)
                    .background(accent.wash(dark: scheme == .dark), in: Circle())
                    .padding(.bottom, 4)
                    .accessibilityHidden(true)
            }
            Text(empty.headline)
                .kitType(.section)
                .foregroundStyle(Surface.ink)
                .multilineTextAlignment(.center)
            if !empty.body.isEmpty {
                Text(empty.body)
                    .kitType(.row)
                    .foregroundStyle(Surface.body)
                    .multilineTextAlignment(.center)
            }
            if !empty.actionLabel.isEmpty, let onAction {
                KitPillButton(label: empty.actionLabel, action: onAction)
                    .accessibilityIdentifier(actionIdentifier)
                    .padding(.top, 6)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
        .padding(.horizontal, 20)
        .kitCard()
        .padding(.vertical, 12)
        .padding(.horizontal, CentraidGeometry.pageMargin)
        // A CONTAINER, OR THE ID LEAKS: on a plain stack SwiftUI hands
        // `kit-empty` down to the import and action buttons, over their own.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("kit-empty")
    }
}

private struct AskChatKey: EnvironmentKey {
    static var defaultValue: ((Centraid_Core_V1_Route) -> Void)? { nil }
}

extension EnvironmentValues {
    /// The shell's "ask the assistant" door, or nil where there is none
    /// (previews): it pushes the `chat.ask` route the search's `SearchAsk`
    /// carries (#1097, R-1097-30), and builds none of its own.
    var askChat: ((Centraid_Core_V1_Route) -> Void)? {
        get { self[AskChatKey.self] }
        set { self[AskChatKey.self] = newValue }
    }
}

/// THE ASK ROW AT THE FOOT OF AN APP'S SEARCH ANSWER (#1097, R-1097-30, #1135),
/// whether or not anything matched. The label, the question and the chat scope
/// are the machine's (`SearchAsk`), and so is the route a tap opens, the
/// assistant asking the question scoped to the app the member searched from;
/// this view only draws the label and hands that route to the shell. Drawn only where the state holds
/// a row (`hasAskRow`): a term typed since, a denial, or an app that offers none
/// (Locker never does, R-1097-29, and does not draw this view) holds none.
struct SearchAskRow: View {
    let ask: Centraid_Core_V1_SearchAsk
    /// Home records the search as a recent one when its row is pressed.
    var onAsk: (() -> Void)? = nil
    /// A view whose state carries the Ask's finished route (Home's search) pushes it itself and
    /// needs no door; every other search hands the row to the shell's.
    var handoff: (() -> Void)? = nil
    /// False inside a column that already stands on the page margin, so the row's words
    /// start where the column's do.
    var inset: Bool = true

    @Environment(\.askChat) private var askChat
    @Environment(\.appAccent) private var accent

    var body: some View {
        if let press = handoff ?? (ask.hasRoute ? askChat.map({ door in { door(ask.route) } }) : nil) {
            Button {
                onAsk?()
                press()
            } label: {
                Text(ask.label)
                    .kitType(.row)
                    .fontWeight(.semibold)
                    .foregroundStyle(accent.text)
                    .padding(.horizontal, inset ? CentraidGeometry.pageMargin : 0)
                    .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("search-ask-about")
        }
    }
}

/// The Photos views' name for an empty sentence with an optional remedy line.
struct ScreenEmptyView: View {
    let sentence: String
    var remedy: String = ""

    var body: some View {
        EmptyStateView(headline: sentence, body: remedy)
    }
}

/// THE DENIED GATE, WITH ITS RECEIPT (handoff README, "the denied gate with its
/// receipt"). A seat the vault does not grant this app sees why, and the
/// receipt that says which grant is missing — and no band, because there is
/// nowhere in the app to go. `AppPlace` hides its band when its content is
/// denied.
struct DeniedGate: View {
    let denied: Centraid_Core_V1_Denied

    @Environment(\.colorScheme) private var scheme

    init(_ denied: Centraid_Core_V1_Denied) { self.denied = denied }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(denied.title)
                .kitType(.section)
                .foregroundStyle(Surface.ink)
                .accessibilityAddTraits(.isHeader)
            if !denied.body.isEmpty {
                Text(denied.body)
                    .kitType(.row)
                    .foregroundStyle(Surface.body)
            }
            if !denied.receipt.isEmpty {
                Text(denied.receipt)
                    .centraidType("mono")
                    .foregroundStyle(Theme.color("textFaint", scheme))
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.radius("sm", scheme))
                            .strokeBorder(Theme.color("line", scheme), lineWidth: CentraidGeometry.hairline)
                    )
                    .padding(.top, 4)
                    .accessibilityIdentifier("kit-denied-receipt")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(CentraidGeometry.pageMargin)
        .accessibilityIdentifier("kit-denied")
    }
}

/// A SECONDARY VERB: text in ink over a hairline outline, 44pt tall. The
/// kit's Retry, empty action and Show more all draw this, so none of them
/// competes with a screen's one ink button.
///
/// **IT HUGS ITS LABEL** and sits on the leading edge of the text above it.
/// There is no width switch on the call: the one place an outline stretches
/// is inside a `KitChoiceStack`, which hands every button in it the same full
/// width.
struct KitOutlineButton: View {
    let label: String
    var tone: String = "text"
    /// A 16 glyph before the label, in the tone's ink.
    var iconKey: String = ""
    let action: () -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.isEnabled) private var enabled
    /// Set by the nearest `KitChoiceStack`: the stack's width, not the label's.
    @Environment(\.inChoiceStack) private var stacked
    /// Set by a `KitChoiceRow`: the keys share one line, so the label gets the room.
    @Environment(\.inChoiceRow) private var inRow

    var body: some View {
        let ink = enabled ? tone : "textDisabled"
        Button(action: action) {
            HStack(spacing: 6) {
                if !iconKey.isEmpty {
                    CentraidIconView(iconKey: iconKey, tint: Theme.color(ink, scheme), size: 16)
                }
                Text(label)
                    .kitType(.row)
                    .fontWeight(.semibold)
                    .foregroundStyle(Theme.color(ink, scheme))
                    .lineLimit(inRow ? 1 : nil)
                    .minimumScaleFactor(inRow ? 0.8 : 1)
            }
            .padding(.horizontal, inRow ? 8 : 16)
            .frame(maxWidth: stacked ? .infinity : nil, minHeight: CentraidGeometry.targetMinCoarse)
            .overlay(
                Capsule()
                    .strokeBorder(
                        enabled ? (tone == "text" ? Surface.border : StateColor.red.text) : Surface.fill,
                        lineWidth: CentraidGeometry.hairline
                    )
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Choice stack

private struct InChoiceStackKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// True inside a `KitChoiceStack`, where an outline button stretches.
    var inChoiceStack: Bool {
        get { self[InChoiceStackKey.self] }
        set { self[InChoiceStackKey.self] = newValue }
    }
}

private struct InChoiceRowKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// True inside a `KitChoiceRow`, where the outline buttons share one line.
    var inChoiceRow: Bool {
        get { self[InChoiceRowKey.self] }
        set { self[InChoiceRowKey.self] = newValue }
    }
}

/// A SHORT SET OF ACTIONS ON ONE LINE (#1173): the event page's Open in Maps, Edit and Cancel.
/// Every button takes an equal share of the width, in the stack's full-width look, with 10
/// between them.
struct KitChoiceRow<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        HStack(spacing: 10) {
            content()
        }
        .frame(maxWidth: .infinity)
        .environment(\.inChoiceStack, true)
        .environment(\.inChoiceRow, true)
    }
}

/// ALTERNATIVES STACKED VERTICALLY: an ink button and its Cancel or Not now,
/// or a set of choices like a Money transaction's offers. Every button in the stack shares
/// one full width, ink and outline alike, so the column reads as one set of
/// answers to one question. This is the only place an outline stretches; an
/// outline anywhere else hugs its label.
struct KitChoiceStack<Content: View>: View {
    @ViewBuilder let content: () -> Content

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.spacing("3", scheme)) {
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .environment(\.inChoiceStack, true)
    }
}
