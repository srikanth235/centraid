import SwiftUI

// THE FOUR READ SHAPES, DRAWN ONCE (K5; DESIGN.md "The seven rooms").
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
    let data: (Value) -> Content

    init(
        content: ScreenContent<Value>,
        @ViewBuilder skeleton: @escaping () -> Skeleton,
        onRetry: (() -> Void)?,
        @ViewBuilder data: @escaping (Value) -> Content
    ) {
        self.content = content
        self.skeleton = skeleton
        self.onRetry = onRetry
        self.data = data
    }

    var body: some View {
        switch content {
        case .loading:
            skeleton()
        case let .failure(sentence, remedy):
            FailureView(sentence: sentence, remedy: remedy, onRetry: onRetry)
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
        loadingLabel: String = "Opening",
        onRetry: (() -> Void)?,
        @ViewBuilder data: @escaping (Value) -> Content
    ) {
        self.init(
            content: content,
            skeleton: { RowSkeleton(label: loadingLabel) },
            onRetry: onRetry,
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
    var label: String = "Opening"

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
    var retryLabel: String = "Try again"
    let onRetry: (() -> Void)?

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(sentence)
                .centraidType("body")
                .foregroundStyle(Theme.color("text", scheme))
            if !remedy.isEmpty {
                Text(remedy)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
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

/// NOTHING HERE, AND WHY — one sentence and at most one action (DESIGN.md
/// copy table). The strings are finished in the machine; the action is the
/// screen's own event, so the view takes a closure.
struct EmptyStateView: View {
    let empty: Centraid_Screen_V1_EmptyState
    var onAction: (() -> Void)? = nil

    @Environment(\.colorScheme) private var scheme

    init(_ empty: Centraid_Screen_V1_EmptyState, onAction: (() -> Void)? = nil) {
        self.empty = empty
        self.onAction = onAction
    }

    /// For a screen whose state carries plain strings rather than the kit message.
    init(headline: String, body: String = "", actionLabel: String = "", onAction: (() -> Void)? = nil) {
        var empty = Centraid_Screen_V1_EmptyState()
        empty.headline = headline
        empty.body = body
        empty.actionLabel = actionLabel
        self.init(empty, onAction: onAction)
    }

    var body: some View {
        VStack(spacing: 8) {
            Text(empty.headline)
                .centraidType("body")
                .foregroundStyle(Theme.color("text", scheme))
                .multilineTextAlignment(.center)
            if !empty.body.isEmpty {
                Text(empty.body)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .multilineTextAlignment(.center)
            }
            if !empty.actionLabel.isEmpty, let onAction {
                KitOutlineButton(label: empty.actionLabel, action: onAction)
                    .accessibilityIdentifier("kit-empty-action")
                    .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 32)
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .accessibilityIdentifier("kit-empty")
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
    let denied: Centraid_Screen_V1_Denied

    @Environment(\.colorScheme) private var scheme

    init(_ denied: Centraid_Screen_V1_Denied) { self.denied = denied }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(denied.title)
                .centraidType("title")
                .foregroundStyle(Theme.color("text", scheme))
                .accessibilityAddTraits(.isHeader)
            if !denied.body.isEmpty {
                Text(denied.body)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
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
struct KitOutlineButton: View {
    let label: String
    var tone: String = "text"
    let action: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: action) {
            Text(label)
                .centraidType("smallStrong")
                .foregroundStyle(Theme.color(tone, scheme))
                .padding(.horizontal, 16)
                .frame(minHeight: CentraidGeometry.targetMinCoarse)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                        .strokeBorder(
                            Theme.color(tone == "text" ? "lineStrong" : tone, scheme),
                            lineWidth: CentraidGeometry.hairline
                        )
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
