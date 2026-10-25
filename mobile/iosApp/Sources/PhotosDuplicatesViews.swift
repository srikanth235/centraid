import SwiftUI

import CentraidShared

/// THE NEAR-DUPLICATE SETS (#1135): `photos.duplicates`, drawn. A list of
/// DECISIONS, not of photographs: each row is the way in to `photos.duplicate_review`,
/// where the member sees the copies side by side and picks the one that survives.
/// Nothing on this screen deletes anything. Every word is Rust's; a row carries
/// the `Route` it opens.
struct PhotosDuplicatesView: View {
    @Environment(\.colorScheme) private var scheme

    let state: Centraid_Core_V1_PhotosDuplicatesState
    let send: (Centraid_Core_V1_PhotosDuplicatesEvent.OneOf_Kind) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onBack: () -> Void
    var parentTitle: String = ""

    private var content: ScreenContent<Centraid_Core_V1_PhotosDuplicatesData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .gated(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }

    var body: some View {
        PushedPage(title: state.title, parentTitle: parentTitle, onBack: onBack) {
            EmptyView()
        } content: {
            ReadStateView(
                content: content,
                onRetry: { send(.refreshed(.init())) }
            ) { data in
                if data.hasEmpty {
                    EmptyStateView(data.empty.legacy)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(data.lede)
                                .centraidType("small")
                                .foregroundStyle(Theme.color("textSoft", scheme))
                            if !data.reclaim.isEmpty {
                                Text(data.reclaim)
                                    .centraidType("small")
                                    .foregroundStyle(Theme.color("textSoft", scheme))
                            }
                            ForEach(data.sets, id: \.clusterKey) { set in
                                Button {
                                    open(set.route)
                                } label: {
                                    DuplicateSetRow(set: set)
                                }
                                .buttonStyle(KitRowPress())
                                .accessibilityIdentifier("photos.duplicates.\(set.clusterKey)")
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .contentMargins(.horizontal, CentraidGeometry.pageMargin, for: .scrollContent)
                }
            }
        }
    }
}

/// ONE SET, AS A ROW: the headline and what resolving it gives back.
private struct DuplicateSetRow: View {
    @Environment(\.colorScheme) private var scheme
    let set: Centraid_Core_V1_PhotosDuplicateSet

    var body: some View {
        HStack(spacing: 10) {
            // ONE OF THE COPIES, SO THE ROW IS ABOUT A PHOTOGRAPH; the `dupe` mark
            // stands in when this phone holds none of them.
            if set.hasCover, set.cover.hasThumbnailPath, !set.cover.thumbnailPath.isEmpty {
                ContentImage(path: set.cover.thumbnailPath)
                    .frame(width: 44, height: 44)
                    .clipped()
                    .accessibilityHidden(true)
            } else {
                CentraidIconView(iconKey: "dupe", tint: Theme.color("text", scheme), size: 20)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(set.headline).centraidType("bodyStrong")
                Text(set.subhead)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
            Spacer(minLength: 8)
            CentraidIconView(iconKey: "ChevronRight", tint: Theme.color("textSoft", scheme))
        }
        .frame(minHeight: CentraidGeometry.targetMinCoarse)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(set.accessibilityLabel)
    }
}

/// ONE SET, AND THE DECISION THAT DELETES A MEMBER'S PHOTOGRAPHS (#1135):
/// `photos.duplicate_review`, drawn. Three things are kept apart because getting
/// any of them wrong costs somebody their photographs:
///
/// 1. **NOTHING IS PICKED UNTIL THE MEMBER PICKS IT.** The control that trashes the
///    rest is disabled and SAYS why until one is.
/// 2. **THE SUGGESTION IS A HINT ON A ROW, NEVER A TICKED BOX.**
/// 3. **TRASH IS NOT PURGE.** There is no permanent option on this screen.
struct PhotosDuplicateReviewView: View {
    @Environment(\.colorScheme) private var scheme

    let state: Centraid_Core_V1_PhotosDuplicateReviewState
    let send: (Centraid_Core_V1_PhotosDuplicateReviewEvent.OneOf_Kind) -> Void
    let onBack: () -> Void
    var parentTitle: String = ""

    private var content: ScreenContent<Centraid_Core_V1_PhotosDuplicateReviewData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .gated(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }

    var body: some View {
        PushedPage(title: state.title, parentTitle: parentTitle, onBack: onBack) {
            EmptyView()
        } content: {
            VStack(spacing: 0) {
                ReadStateView(
                    content: content,
                    onRetry: { send(.refreshed(.init())) }
                ) { data in
                    if data.hasEmpty {
                        EmptyStateView(data.empty.legacy)
                    } else {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 12) {
                                header(data)
                                ForEach(data.members, id: \.photoID) { member in
                                    Button {
                                        send(.keep(.with { $0.photoID = member.photoID }))
                                    } label: {
                                        DuplicateMemberRow(member: member)
                                    }
                                    .buttonStyle(KitRowPress())
                                    .accessibilityIdentifier("photos.duplicate.member.\(member.photoID)")
                                }
                                resolve(data)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .contentMargins(.horizontal, CentraidGeometry.pageMargin, for: .scrollContent)
                    }
                }
                // A REFUSED TRASH SAYS SO, BESIDE THE LIST AND NEVER INSTEAD OF IT:
                // silence here is the worst outcome this screen has, since a
                // resolve is one write per copy and some can commit while others
                // are refused.
                if state.hasStatus, !state.status.sentence.isEmpty {
                    Text(state.status.sentence)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("net", scheme))
                        .padding(CentraidGeometry.pageMargin)
                        .accessibilityIdentifier("photos.duplicate.refusal")
                }
            }
        }
    }

    @ViewBuilder
    private func header(_ data: Centraid_Core_V1_PhotosDuplicateReviewData) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(data.pickLine).centraidType("body")
            Text(data.pickCaption)
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))
            // WHAT WAS CHECKED, SAID OUT LOUD: albums are, favorites are not.
            Label {
                Text(data.checkedLine)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            } icon: {
                CentraidIconView(iconKey: "info", tint: Theme.color("textSoft", scheme))
            }
        }
    }

    /// The verb, and the sentence that says why it is not available yet: a
    /// disabled control with no explanation is a broken control.
    @ViewBuilder
    private func resolve(_ data: Centraid_Core_V1_PhotosDuplicateReviewData) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            KitOutlineButton(
                label: data.resolveLabel,
                tone: data.resolveEnabled ? "net" : "textDisabled",
                iconKey: "trash"
            ) {
                send(.resolve(.init()))
            }
            .disabled(!data.resolveEnabled)
            .accessibilityIdentifier("photos.duplicate.resolve")
            if !data.resolveHint.isEmpty {
                Text(data.resolveHint)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
        }
        .padding(.top, 8)
    }
}

/// ONE COPY, WITH WHAT DISTINGUISHES IT FROM ITS SIBLINGS. The tick is the
/// MEMBER'S pick (an outline on the thumbnail) and the hint is Rust's suggestion,
/// drawn by two different things on purpose: a suggestion that borrowed the tick
/// would be a pre-ticked box.
private struct DuplicateMemberRow: View {
    @Environment(\.colorScheme) private var scheme
    let member: Centraid_Core_V1_PhotosDuplicateMember

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            ZStack {
                Theme.color("skel", scheme)
                if member.tile.hasThumbnailPath, !member.tile.thumbnailPath.isEmpty {
                    ContentImage(path: member.tile.thumbnailPath)
                }
            }
            .frame(width: 72, height: 72)
            .clipped()
            .overlay {
                if member.kept {
                    Rectangle().strokeBorder(Theme.color("text", scheme), lineWidth: 2)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(member.facts).centraidType("bodyStrong")
                Text(member.captured)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                if member.inAlbum {
                    Label {
                        Text(member.inAlbumLabel)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                    } icon: {
                        CentraidIconView(iconKey: "album", tint: Theme.color("textSoft", scheme))
                    }
                }
                if !member.suggestion.isEmpty {
                    Label {
                        Text(member.suggestion)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                    } icon: {
                        CentraidIconView(iconKey: "info", tint: Theme.color("textSoft", scheme))
                    }
                }
            }
            Spacer(minLength: 8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(member.accessibilityLabel)
    }
}
