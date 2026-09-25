import SwiftUI

// THE ROOMS (K5; DESIGN.md "The seven rooms (mobile)").
//
// A mobile screen is one of seven rooms and nothing else. The room owns the
// header, the back control, search, the empty/loading/error states (through
// `ReadStateView`), the status host and the gutter; the app supplies content
// and copy. A screen that hand-rolls any of those is a finding, not a variant
// — so a port's view is a room with content in it, and nothing around it.
//
// `HomeRoom` is `HomeView`, `StageRoom` is the lightbox's own, and
// `SystemPlace` is the vault/settings sheets; the four every app port needs
// live here.

/// THE SEARCH SLOT an `AppPlace` opens under its header. The field's state is
/// the machine's `SearchField`; the words are the app's copy.
struct SearchSlot {
    let field: Centraid_Screen_V1_SearchField
    let placeholder: String
    var closeLabel: String = "Close search"
    let onTerm: (String) -> Void
    let onClose: () -> Void
}

/// AN APP'S ROOT: `AppHeader` (mark + name + at most one trailing action), the
/// optional search under it, the content, and the app's band at the foot as a
/// render prop.
///
/// The system navigation bar is hidden: an app place has no back — the band's
/// Home capsule is the way out — and a second header over the app's own would
/// be two grounds for one title. `showsBand` is false for a denied room, which
/// has nowhere in the app to go.
struct AppPlace<Trailing: View, Band: View, Content: View>: View {
    let app: String
    let title: String
    var search: SearchSlot? = nil
    var showsBand: Bool = true
    let trailing: () -> Trailing
    let band: () -> Band
    let content: () -> Content

    @Environment(\.colorScheme) private var scheme

    init(
        app: String,
        title: String,
        search: SearchSlot? = nil,
        showsBand: Bool = true,
        @ViewBuilder trailing: @escaping () -> Trailing,
        @ViewBuilder band: @escaping () -> Band,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.app = app
        self.title = title
        self.search = search
        self.showsBand = showsBand
        self.trailing = trailing
        self.band = band
        self.content = content
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                AppMark(appID: app, size: 28)
                Text(title)
                    .centraidType("title")
                    .foregroundStyle(Theme.color("text", scheme))
                    .lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                trailing()
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .frame(minHeight: 52)
            .accessibilityIdentifier("\(app)-app-header")
            if let search, search.field.open {
                CentraidSearchField(
                    field: search.field,
                    placeholder: search.placeholder,
                    closeLabel: search.closeLabel,
                    identifier: "\(app)-search",
                    onTerm: search.onTerm,
                    onClose: search.onClose
                )
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.bottom, 8)
            }
            content()
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.color("bg", scheme).ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if showsBand {
                band()
                    .background(Theme.color("bg", scheme).ignoresSafeArea(edges: .bottom))
            }
        }
    }
}

/// A PAGE PUSHED FROM A PLACE: `PlaceHeader` with back to the NAMED parent and
/// at most one trailing action. The parent's name is the caller's computed
/// title, never a literal "Back".
struct PushedPage<Trailing: View, Content: View>: View {
    let title: String
    let parentTitle: String
    let onBack: () -> Void
    let trailing: () -> Trailing
    let content: () -> Content

    @Environment(\.colorScheme) private var scheme

    init(
        title: String,
        parentTitle: String,
        onBack: @escaping () -> Void,
        @ViewBuilder trailing: @escaping () -> Trailing,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.parentTitle = parentTitle
        self.onBack = onBack
        self.trailing = trailing
        self.content = content
    }

    var body: some View {
        content()
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Theme.color("bg", scheme).ignoresSafeArea())
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(true)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: onBack) {
                        HStack(spacing: 2) {
                            CentraidIconView(iconKey: "ChevronLeft", tint: Theme.color("text", scheme), size: 18)
                            Text(parentTitle)
                                .centraidType("body")
                                .foregroundStyle(Theme.color("text", scheme))
                                .lineLimit(1)
                                .fixedSize()
                        }
                        .frame(minHeight: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Back to \(parentTitle)")
                    .accessibilityIdentifier("kit-pushed-back")
                }
                ToolbarItem(placement: .topBarTrailing) { trailing() }
            }
    }
}

/// A FULL-SCREEN EDITOR: autosave, close = done, band hidden, the status line
/// hosted inside (#1015 D3).
///
/// There is no Save. The machine saves on its own debounce; Done only leaves,
/// and leaving is the flush — `onDeparted` runs when the room goes off screen
/// by any route (Done, a pop, Home), and the registry forwards it to the
/// bridge's `departed()`, which sends the machine's `Left` so unsaved words
/// are written without closing the bridge.
struct EditorRoom<Trailing: View, Content: View>: View {
    let title: String
    let status: Centraid_Screen_V1_Autosave
    var closeLabel: String = "Done"
    let onClose: () -> Void
    let onDeparted: () -> Void
    let trailing: () -> Trailing
    let content: () -> Content

    @Environment(\.colorScheme) private var scheme

    init(
        title: String,
        status: Centraid_Screen_V1_Autosave,
        closeLabel: String = "Done",
        onClose: @escaping () -> Void,
        onDeparted: @escaping () -> Void,
        @ViewBuilder trailing: @escaping () -> Trailing,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.status = status
        self.closeLabel = closeLabel
        self.onClose = onClose
        self.onDeparted = onDeparted
        self.trailing = trailing
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            AutosaveStatus(status)
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.bottom, 4)
            content()
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .background(Theme.color("bg", scheme).ignoresSafeArea())
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button(action: onClose) {
                    Text(closeLabel)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("text", scheme))
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, 8)
                        .frame(minHeight: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("kit-editor-close")
            }
            ToolbarItem(placement: .topBarTrailing) { trailing() }
        }
        .onDisappear(perform: onDeparted)
    }
}

/// THE ONE INK BUTTON a sheet may carry.
struct SheetPrimary {
    let label: String
    var destructive: Bool = false
    let action: () -> Void
}

/// A SHEET: grabber, a title carrying the noun, at most one ink button, and a
/// status line hosted inside. Present it with `.sheet`; the room sets its own
/// grabber and detents.
struct SheetRoom<Content: View>: View {
    let title: String
    var status: String = ""
    var primary: SheetPrimary? = nil
    let content: () -> Content

    @Environment(\.colorScheme) private var scheme

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
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .centraidType("title")
                .foregroundStyle(Theme.color("text", scheme))
                .accessibilityAddTraits(.isHeader)
                .padding(.top, 20)
            content()
            if !status.isEmpty {
                Text(status)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .accessibilityIdentifier("kit-sheet-status")
            }
            if let primary {
                KitInkButton(label: primary.label, destructive: primary.destructive, action: primary.action)
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.bottom, 16)
        // THE ROOM FILLS ITS SHEET, top-aligned: sized to its content, it
        // floated mid-sheet as a band of `bgElev` between two slabs of the
        // system's own sheet ground.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .presentationBackground(Theme.color("bgElev", scheme))
        .presentationDragIndicator(.visible)
        .presentationDetents([.medium, .large])
    }
}

/// A sheet's primary verb. **A DESTRUCTIVE ONE IS AN OUTLINE IN `net`**, never
/// a filled red slab (handoff: "the destructive outline"): prominence is earned
/// by consequence, and the consequence is carried by the colour and the
/// sentence, not by shouting.
struct KitInkButton: View {
    let label: String
    var destructive: Bool = false
    let action: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: action) {
            Text(label)
                .centraidType("labelOn")
                .foregroundStyle(Theme.color(destructive ? "net" : "onAccent", scheme))
                .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
                .background {
                    if !destructive {
                        RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                            .fill(Theme.color("accent", scheme))
                    }
                }
                .overlay {
                    if destructive {
                        RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                            .strokeBorder(Theme.color("net", scheme), lineWidth: 1.5)
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(destructive ? "kit-destructive" : "kit-primary")
    }
}
