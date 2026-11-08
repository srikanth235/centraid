import SwiftUI
import UIKit

// THE ROOMS (K5; product-intuition/references/design-behaviour.md § Rooms).
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

/// THE SEARCH SLOT an `AppPlace` carries. The field's state is the machine's `SearchField`;
/// the words are the app's copy.
///
/// **SEARCH IS ALWAYS IN THE SAME PLACE** (R-CHROME-2): a round key at the trailing end of the
/// app's band, the way the system Photos app has it. Closed, the band draws the key
/// (`BandSearchKey`, handed to `AppBand` through the environment) and a tap sends `onOpen`;
/// open, the field takes the band's place at the foot, over the keyboard (`BandSearchField`),
/// and its close key brings the band back. Never a More row, a header glyph or a band tab; an
/// app with no search slot gets no key. An app whose search is a page of its own (Photos)
/// pushes it from `onOpen` and never sets `field.open`.
struct SearchSlot {
    let field: KitSearchField
    let placeholder: String
    var closeLabel: String = KitWords.CLOSE_SEARCH
    let onOpen: () -> Void
    let onTerm: (String) -> Void
    let onClose: () -> Void
}

/// THE BAND'S SEARCH KEY, as an `AppPlace` hands it to the band it draws: the words a screen
/// reader says for it and the open. Nil in the environment where the app has no search.
struct BandSearchKey {
    let label: String
    let onOpen: () -> Void
}

private struct BandSearchKeyKey: EnvironmentKey {
    static var defaultValue: BandSearchKey? { nil }
}

extension EnvironmentValues {
    var bandSearchKey: BandSearchKey? {
        get { self[BandSearchKeyKey.self] }
        set { self[BandSearchKeyKey.self] = newValue }
    }
}

/// THE FOOT OF A PAGE THAT HAS SEARCH BUT NO BAND (Docs' folder page, a pushed page under an
/// app): the search key alone at the trailing edge — `AppBand`'s own circle, in the same place —
/// and, once opened, the field in its place at the foot. A pushed page stands under its parent
/// and has no band to hang the key on, so the key stands where it would have been.
struct SearchFoot: View {
    let search: SearchSlot
    let identifier: String

    var body: some View {
        VStack(spacing: 0) {
            if search.field.open {
                BandSearchField(
                    field: search.field,
                    placeholder: search.placeholder,
                    closeLabel: search.closeLabel,
                    identifier: identifier,
                    onTerm: search.onTerm,
                    onClose: search.onClose
                )
            } else {
                HStack(spacing: 0) {
                    Spacer(minLength: 0)
                    BandKey(
                        iconKey: "Search",
                        spoken: search.placeholder,
                        identifier: "band-search",
                        action: search.onOpen
                    )
                }
                .padding(.horizontal, BandMetrics.inset)
                .padding(.top, BandMetrics.topGap)
                .padding(.bottom, BandMetrics.floorPadding)
            }
        }
        .bandStrip()
    }
}

/// THE HEADER'S ONE TRAILING ACTION (R-CHROME-1): a glyph from the catalog and
/// the words a screen reader says for it — the app's create verb ("Plus") on
/// every app that makes things, and Photos' Select on the one that does not.
/// A value, not a view, so an `AppPlace` cannot carry two; the twin of
/// Android's `RoomAction`.
struct RoomAction {
    let iconKey: String
    let label: String
    var identifier: String = "room-action"
    var enabled: Bool = true
    let action: () -> Void
}

/// The search bar while search is closed, for a page that keeps its own field under its
/// header (Chat's drawer): field-shaped, so it reads as the place to type before it is one.
/// An app place's search is the band's key instead (`BandSearchKey`).
struct SearchOpener: View {
    let placeholder: String
    var identifier: String = "search-opener"
    let onOpen: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 8) {
                CentraidIconView(iconKey: "Search", tint: Theme.color("textFaint", scheme), size: 16)
                Text(placeholder)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("textFaint", scheme))
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
            .background(
                Theme.color("bgSunken", scheme),
                in: RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                    .strokeBorder(Theme.color("line", scheme), lineWidth: CentraidGeometry.hairline)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(placeholder)
        .accessibilityIdentifier(identifier)
    }
}

/// A PLACE'S OWN BAR (#1173): the Calendar's header stands in the system bar, a leading chip and
/// the keys before the app's one verb, and the page draws no title. Values, so a place passes
/// views and the kit stays ignorant of what they are.
struct PlaceBar {
    let leading: AnyView
    let actions: AnyView
}

/// THE TRAILING SLOT, drawn: the bar's glyph for the one action, or nothing.
struct RoomTrailing: View {
    let action: RoomAction?
    /// The place's app id: the toolbar does not carry the environment, so the accent is stated.
    var app: String = ""

    var body: some View {
        if let action {
            if action.iconKey == "Plus" {
                // THE CREATE VERB is the filled key in the app's accent.
                KitAccentKey(
                    iconKey: action.iconKey,
                    label: action.label,
                    identifier: action.identifier,
                    enabled: action.enabled,
                    accent: AppAccent(app),
                    action: action.action
                )
            } else {
                ToolbarIcon(iconKey: action.iconKey, label: action.label, identifier: action.identifier, action: action.action)
                    .disabled(!action.enabled)
            }
        }
    }
}

/// AN APP'S ROOT: the app's name in the system navigation bar with at most two trailing items
/// (the filter menu, then the app's one verb), the content, and the app's band at the foot as a
/// render prop. The order is the same in every app (R-CHROME-1…4): filter and add top right, list,
/// band, with search as the band's trailing key.
///
/// **SEARCH LIVES AT THE FOOT.** With a `search` slot the band carries a round key at its
/// trailing end (`BandSearchKey`); a tap opens the field IN THE BAND'S PLACE, over the keyboard,
/// and its close key puts the band back. Nothing is drawn under the header for it, so the
/// content is the first thing under the bar.
///
/// **THE BAND IS GLASS AND THE CONTENT RUNS UNDER IT.** The band stands in the bottom safe-area
/// inset on nothing (`BandStrip`), so a scroll view in the content scrolls beneath it and the
/// inset is what holds its last row clear. Under Reduce Transparency or Increase Contrast the
/// strip is the page colour again and the plates are solid (`BandGround`).
///
/// **THE SYSTEM BAR, NOT A DRAWN HEADER** — the same bar Photos and Agenda
/// stand under, so every app's back and trailing verb are the platform's glass
/// controls in the same place. A drawn header put Docs' "Add" as bare text
/// where Photos' "Select" sat in glass: two apps, two grammars for one slot.
/// `showsBand` is false for a denied room, which has nowhere in the app to go.
/// THE SHELL'S STATUS LINE, handed down to whichever place draws it above its
/// band (`ShellLineHost`); nil where the shell has none to give.
private struct ShellStatusLineKey: EnvironmentKey {
    static var defaultValue: AnyView? { nil }
}

extension EnvironmentValues {
    var shellStatusLine: AnyView? {
        get { self[ShellStatusLineKey.self] }
        set { self[ShellStatusLineKey.self] = newValue }
    }
}

/// A PLACE THAT DRAWS THE SHELL'S LINE ITSELF tells its host so, and the host
/// does not draw a second one at the page's foot.
struct PlaceDrawsShellLine: PreferenceKey {
    static let defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) { value = value || nextValue() }
}

struct AppPlace<Trailing: View, Band: View, Content: View>: View {
    let app: String
    let title: String
    var search: SearchSlot? = nil
    /// A KEY BEFORE THE FILTER (#1173): the glass lock key of Locker's header. Nil in every other app.
    var lead: RoomAction? = nil
    /// THE HEADER'S FILTER BUTTON (R-CHROME-3): Rust's `FilterMenu`, drawn as a menu beside the
    /// app's one trailing action. Nil where the app has nothing to filter or sort.
    var filter: FilterSlot? = nil
    /// The scope the page is in, under the app's name (Notes' notebook, Money's month).
    var subtitle: SubtitleSlot? = nil
    /// A bar of the place's own: no drawn title, its leading view and keys in the system bar.
    var bar: PlaceBar? = nil
    var showsBand: Bool = true
    let trailing: () -> Trailing
    let band: () -> Band
    let content: () -> Content

    @Environment(\.colorScheme) private var scheme
    @Environment(\.shellStatusLine) private var shellLine
    @State private var keyboardUp = false

    /// File-private: an app passes its one action as a `RoomAction` value
    /// (R-CHROME-1), through the init below.
    fileprivate init(
        app: String,
        title: String,
        search: SearchSlot? = nil,
        lead: RoomAction? = nil,
        filter: FilterSlot? = nil,
        subtitle: SubtitleSlot? = nil,
        bar: PlaceBar? = nil,
        showsBand: Bool = true,
        @ViewBuilder trailing: @escaping () -> Trailing,
        @ViewBuilder band: @escaping () -> Band,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.app = app
        self.title = title
        self.search = search
        self.lead = lead
        self.filter = filter
        self.subtitle = subtitle
        self.bar = bar
        self.showsBand = showsBand
        self.trailing = trailing
        self.band = band
        self.content = content
    }

    var body: some View {
        VStack(spacing: 0) {
            // THE HEADER IS THE PAGE'S: the title at 34 bold, the scope under it. The system bar
            // above carries only the keys (the glass filter and the filled accent `+`) and a
            // back chevron where the place was pushed.
            if bar == nil { KitHeader(title: title, subtitle: subtitle) }
            content()
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Surface.page.ignoresSafeArea())
        .environment(\.appAccent, AppAccent(app))
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        // AN APP ROOT HAS NO BACK CHEVRON: it is reached from Home and returns by the band's
        // Home key; a chevron appears only on a page drilled into (`PushedPage`).
        .navigationBarBackButtonHidden(true)
        .toolbar {
            // THE HEADER'S TWO TRAILING ITEMS: the filter menu, then the app's one verb.
            if let bar {
                ToolbarItem(placement: .topBarLeading) {
                    bar.leading.environment(\.appAccent, AppAccent(app))
                }
            }
            ToolbarItemGroup(placement: .primaryAction) {
                if let bar { bar.actions.environment(\.appAccent, AppAccent(app)) }
                if let lead { RoomTrailing(action: lead, app: app) }
                if let filter { FilterMenuButton(app: app, slot: filter) }
                // THE BAR IS HOSTED OUTSIDE THE PAGE'S ENVIRONMENT, so the filled `+` takes the
                // app's accent from here and not the shell's teal.
                trailing().environment(\.appAccent, AppAccent(app))
            }
            // The title is drawn in the page, so the bar's own is put away; the item keeps the
            // back label the system takes from `navigationTitle`.
            ToolbarItem(placement: .principal) {
                Color.clear.frame(width: 1, height: 1).accessibilityHidden(true)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                // THE SHELL'S LINE SITS ON THE BAND, never under it: the band
                // is the foot of every app, and the line reads as its own.
                if let shellLine { shellLine }
                if let search, search.field.open {
                    // OPEN SEARCH TAKES THE BAND'S PLACE, and stays there while the keyboard
                    // goes (the Search key) so the foot is never a blank: it rides the keyboard
                    // while typing and sits where the band sat when not.
                    BandSearchField(
                        field: search.field,
                        placeholder: search.placeholder,
                        closeLabel: search.closeLabel,
                        identifier: "\(app)-search",
                        onTerm: search.onTerm,
                        onClose: search.onClose
                    )
                } else if showsBand, !keyboardUp {
                    // THE BAND IS PUT AWAY WHILE THE KEYBOARD IS UP: riding the keyboard it sat
                    // clipped above the keys, and a member typing is not choosing a destination.
                    // Its trailing key is the app's search, when the app has one.
                    band()
                        .environment(
                            \.bandSearchKey,
                            search.map { BandSearchKey(label: $0.placeholder, onOpen: $0.onOpen) }
                        )
                }
            }
            // GLASS STANDS ON NOTHING: the content scrolls under the plates and shows
            // through them. Under Reduce Transparency or Increase Contrast the strip is the
            // page's colour again (`BandStrip`).
            .bandStrip()
        }
        .preference(key: PlaceDrawsShellLine.self, value: shellLine != nil)
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            keyboardUp = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardUp = false
        }
    }
}

extension AppPlace where Trailing == RoomTrailing {
    /// The room with its one trailing action as a value (R-CHROME-1).
    init(
        app: String,
        title: String,
        trailing: RoomAction?,
        search: SearchSlot? = nil,
        lead: RoomAction? = nil,
        filter: FilterSlot? = nil,
        subtitle: SubtitleSlot? = nil,
        bar: PlaceBar? = nil,
        showsBand: Bool = true,
        @ViewBuilder band: @escaping () -> Band,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.init(
            app: app,
            title: title,
            search: search,
            lead: lead,
            filter: filter,
            subtitle: subtitle,
            bar: bar,
            showsBand: showsBand,
            trailing: { RoomTrailing(action: trailing, app: app) },
            band: band,
            content: content
        )
    }
}

/// A PAGE PUSHED FROM A PLACE: `PlaceHeader` with back to the NAMED parent and
/// at most one trailing action. The parent's name is the caller's computed
/// title, never a literal "Back".
struct PushedPage<Trailing: View, Content: View>: View {
    let title: String
    let parentTitle: String
    let onBack: () -> Void
    /// The kit's own pages (Trash, Settings) draw the title large in the page, with `meta`
    /// under it; a page that heads itself (a document, an editor) leaves this off.
    var showsTitle: Bool = false
    var meta: String = ""
    let trailing: () -> Trailing
    let content: () -> Content

    @Environment(\.colorScheme) private var scheme

    init(
        title: String,
        parentTitle: String,
        onBack: @escaping () -> Void,
        showsTitle: Bool = false,
        meta: String = "",
        @ViewBuilder trailing: @escaping () -> Trailing,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.parentTitle = parentTitle
        self.onBack = onBack
        self.showsTitle = showsTitle
        self.meta = meta
        self.trailing = trailing
        self.content = content
    }

    var body: some View {
        VStack(spacing: 0) {
            if showsTitle { KitHeader(title: title, meta: meta) }
            content()
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Surface.page.ignoresSafeArea())
            .navigationTitle(showsTitle ? "" : title)
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(true)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    // THE BACK KEY IS A CHEVRON IN THE BAR'S OWN GLASS (#1173): a drill-in page
                    // is the only place a back chevron appears. The parent's name is what a
                    // screen reader says.
                    Button(action: onBack) {
                        CentraidIconView(iconKey: "ChevronLeft", tint: Surface.ink, size: 18)
                            .frame(minWidth: 30, minHeight: CentraidGeometry.targetMinCoarse)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(KitWords.backTo(parent: parentTitle))
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
/// by any route (Done, a pop, Home), for a page that has something to say
/// then; the screen itself writes unsaved words when it closes.
struct EditorRoom<Trailing: View, Content: View>: View {
    let title: String
    let status: Centraid_Core_V1_Autosave
    var closeLabel: String = KitWords.DONE
    let onClose: () -> Void
    let onDeparted: () -> Void
    let trailing: () -> Trailing
    let content: () -> Content

    @Environment(\.colorScheme) private var scheme

    init(
        title: String,
        status: Centraid_Core_V1_Autosave,
        closeLabel: String = KitWords.DONE,
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
    /// False draws the button greyed and inert — never hidden.
    var enabled: Bool = true
    var identifier: String = ""
    let action: () -> Void
}

/// AN ALTERNATIVE TO A SHEET'S PRIMARY: Cancel, Not now, or a removal. It is
/// drawn as an outline in the same `KitChoiceStack` as the ink button, under
/// it, so the sheet's answers share one full width.
struct SheetOutline {
    let label: String
    /// `net` when it destroys.
    var tone: String = "text"
    var identifier: String = ""
    let action: () -> Void
}

/// A SHEET: grabber, a title carrying the noun, at most one ink button, and a
/// status line hosted inside. Present it with `.sheet`; the room sets its own
/// grabber and detents.
struct SheetRoom<Content: View>: View {
    let title: String
    var status: String = ""
    var primary: SheetPrimary? = nil
    /// The primary's alternatives, drawn under it in one `KitChoiceStack`.
    var outlines: [SheetOutline] = []
    /// The sheet's own id, carried by its TITLE — a leaf — so it names the
    /// sheet without replacing its children's ids, which an identifier on the
    /// container does (#1047).
    var titleIdentifier: String = ""
    let content: () -> Content

    @Environment(\.colorScheme) private var scheme

    init(
        title: String,
        status: String = "",
        primary: SheetPrimary? = nil,
        outlines: [SheetOutline] = [],
        titleIdentifier: String = "",
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.status = status
        self.primary = primary
        self.outlines = outlines
        self.titleIdentifier = titleIdentifier
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .kitType(.section)
                .foregroundStyle(Surface.ink)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier(titleIdentifier.isEmpty ? "kit-sheet-title" : titleIdentifier)
                .padding(.top, 20)
            content()
            if !status.isEmpty {
                Text(status)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
                    .accessibilityIdentifier("kit-sheet-status")
            }
            if primary != nil || !outlines.isEmpty {
                KitChoiceStack {
                    if let primary {
                        KitInkButton(
                            label: primary.label,
                            destructive: primary.destructive,
                            identifier: primary.identifier,
                            action: primary.action
                        )
                        .disabled(!primary.enabled)
                    }
                    ForEach(Array(outlines.enumerated()), id: \.offset) { _, outline in
                        KitOutlineButton(label: outline.label, tone: outline.tone, action: outline.action)
                            .accessibilityIdentifier(outline.identifier)
                    }
                }
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.bottom, 16)
        // THE ROOM FILLS ITS SHEET, top-aligned: sized to its content, it
        // floated mid-sheet as a band of `bgElev` between two slabs of the
        // system's own sheet ground.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .modifier(SheetPresentation())
    }
}

/// A SHEET'S PRESENTATION — its ground, its grabber, its detents — as one
/// modifier, so a caller that hosts a `SheetRoom` somewhere the presentation
/// preferences cannot climb out of (a capture shield's secure canvas is a
/// hosting controller of its own) can state them again on the sheet's root.
struct SheetPresentation: ViewModifier {
    var detents: Set<PresentationDetent> = [.medium, .large]

    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        content
            .presentationBackground(Surface.sheet)
            .presentationDragIndicator(.visible)
            .presentationDetents(detents)
            // THE TEXT-SIZE CAP, STATED AGAIN: a sheet does not inherit the app
            // root's (see `Theme.textSizeCap`).
            .dynamicTypeSize(...Theme.textSizeCap)
    }
}

/// A sheet's primary verb. **A DESTRUCTIVE ONE IS AN OUTLINE IN `net`**, never
/// a filled red slab (handoff: "the destructive outline"): prominence is earned
/// by consequence, and the consequence is carried by the colour and the
/// sentence, not by shouting.
struct KitInkButton: View {
    let label: String
    var destructive: Bool = false
    /// When non-empty, replaces the default `kit-primary` / `kit-destructive` id.
    var identifier: String = ""
    let action: () -> Void

    @Environment(\.isEnabled) private var enabled
    @Environment(\.appAccent) private var accent

    /// THE ONE FILLED ELEMENT (#1173): a full-width pill in the app's fill under a white label;
    /// a destructive one is the outlined state-red pill at the same width. Disabled is still
    /// drawn: the fill colour with meta ink, never hidden, never faded.
    private var ink: Color {
        guard enabled else { return Surface.meta }
        return destructive ? StateColor.red.text : .white
    }

    var body: some View {
        Button(action: action) {
            Text(label)
                .kitType(.row)
                .fontWeight(.semibold)
                .foregroundStyle(ink)
                .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
                .background {
                    if !destructive {
                        Capsule().fill(enabled ? accent.fill : Surface.fill)
                    }
                }
                .overlay {
                    if destructive {
                        Capsule().strokeBorder(enabled ? StateColor.red.text : Surface.border, lineWidth: 1.5)
                    }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier.isEmpty ? (destructive ? "kit-destructive" : "kit-primary") : identifier)
    }
}
