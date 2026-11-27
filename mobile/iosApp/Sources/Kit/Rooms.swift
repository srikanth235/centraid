import SwiftUI
import UIKit

// THE ROOMS (K5; design/behaviour.md § Rooms).
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

extension View {
    /// THE READABLE COLUMN (ruling 27): on a wide screen (an iPad) the page's content and the floating band
    /// stand in one column `CentraidGeometry.readableWidth` wide, centred, with the page colour either side. A
    /// phone is narrower than the cap, so nothing changes there. Applied once, by the rooms below; `enabled`
    /// false is the opt-out (Photos' justified rows, the Calendar's grids), which keeps the full width.
    ///
    /// `alignment` is where content narrower than the column sits inside it (the leading edge for a header
    /// and an editor, the middle for a list page, as each already stood).
    @ViewBuilder
    func readableColumn(_ enabled: Bool = true, alignment: Alignment = .center) -> some View {
        if enabled {
            frame(maxWidth: .infinity, alignment: alignment)
                .frame(maxWidth: CentraidGeometry.readableWidth)
                .frame(maxWidth: .infinity)
        } else {
            self
        }
    }
}

/// THE BAND'S SEARCH KEY, as the band draws it: the words a screen
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

/// THE TITLE IN THE TOP ROW (#1173, round 9): an app root's title is large at the leading edge of
/// the system bar, on the same row as the trailing keys (iOS 26 Photos' "Library"); the scope line
/// is drawn under it in the page (`KitHeader` with an empty title). The bar's own item, with no
/// glass plate behind it.
struct RootBarTitle: ToolbarContent {
    let title: String

    var body: some ToolbarContent {
        if #available(iOS 26, *) {
            ToolbarItem(placement: .topBarLeading) { label }
                .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .topBarLeading) { label }
        }
    }

    private var label: some View {
        Text(title)
            .kitType(.title)
            .foregroundStyle(Surface.ink)
            .lineLimit(1)
            .fixedSize()
            .accessibilityAddTraits(.isHeader)
            // A BAR ITEM STOPS GROWING AT THE BAR'S OWN CAP (UIKit sizes a bar's items itself: "Recents" grows
            // 1.1x from the default to the largest size while the page's text grows 1.7x), so a long press shows
            // it at the size the member chose, as every system bar's items do (#1202).
            .accessibilityShowsLargeContentViewer { Text(title) }
            .accessibilityIdentifier("kit-header-title")
    }
}

extension View {
    /// An app root's title in the bar's top row, large at the leading edge (see `RootBarTitle`).
    func kitRootTitle(_ title: String) -> some View {
        self
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(true)
            .toolbar { RootBarTitle(title: title) }
    }

    /// A pushed page's title inline in the bar, beside the back chevron.
    func kitInlineTitle(_ title: String) -> some View {
        self.navigationTitle(title).navigationBarTitleDisplayMode(.inline)
    }
}

/// WHERE THE EDGE SWIPE OF AN APP ROOT GOES: Home. The shell states it once on the pages it hosts.
private struct PlaceHomeKey: EnvironmentKey {
    static var defaultValue: (() -> Void)? { nil }
}

extension EnvironmentValues {
    var placeHome: (() -> Void)? {
        get { self[PlaceHomeKey.self] }
        set { self[PlaceHomeKey.self] = newValue }
    }
}

/// A PAGE PUSHED FROM A PLACE: `PlaceHeader` with back to the NAMED parent and
/// at most one trailing action. The parent's name is the caller's computed
/// title, never a literal "Back".
struct PushedPage<Trailing: View, Content: View>: View {
    let title: String
    let parentTitle: String
    let onBack: () -> Void
    /// A scope line under the bar (Trash's "3 items"); the title itself is always the bar's, inline.
    var meta: String = ""
    /// A colour of the page's own for the title (a smart list's, a list's), with its glyph before it.
    var titleColor: Color? = nil
    var titleIcon: String = ""
    var titleIdentifier: String? = nil
    /// False keeps the full width (a Photos shelf); see `readableColumn`.
    var readable: Bool = true
    let trailing: () -> Trailing
    let content: () -> Content

    @Environment(\.colorScheme) private var scheme

    init(
        title: String,
        parentTitle: String,
        onBack: @escaping () -> Void,
        meta: String = "",
        titleColor: Color? = nil,
        titleIcon: String = "",
        titleIdentifier: String? = nil,
        readable: Bool = true,
        @ViewBuilder trailing: @escaping () -> Trailing,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.readable = readable
        self.title = title
        self.parentTitle = parentTitle
        self.onBack = onBack
        self.meta = meta
        self.titleColor = titleColor
        self.titleIcon = titleIcon
        self.titleIdentifier = titleIdentifier
        self.trailing = trailing
        self.content = content
    }

    var body: some View {
        VStack(spacing: 0) {
            if !meta.isEmpty { KitHeader(title: "", meta: meta).readableColumn(readable, alignment: .leading) }
            content()
                .readableColumn(readable)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                // A FLOATING BAR AT THE FOOT (Docs' quick look, a Locker verb row) fades what scrolls
                // under it instead of cutting through its text (#1202).
                .contentMargins(.bottom, 12, for: .scrollContent)
                .softBottomScrollEdge()
        }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Surface.page.ignoresSafeArea())
            .navigationTitle(title)
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
                if titleColor != nil || titleIdentifier != nil {
                    // THE TITLE IN THE PAGE'S OWN COLOUR (ink when it has none, so a page that names its title
                    // by id, the Inbox's `tasks-list-title`, draws it on both shells), still inline in the top row.
                    ToolbarItem(placement: .principal) {
                        HStack(spacing: 6) {
                            if !titleIcon.isEmpty { CentraidIconView(iconKey: titleIcon, tint: titleColor ?? Surface.ink, size: 20) }
                            Text(title)
                                .kitType(.section)
                                .foregroundStyle(titleColor ?? Surface.ink)
                                .lineLimit(1)
                                .accessibilityAddTraits(.isHeader)
                        }
                        // THE ID IS ON THE ROW, not the text: a toolbar item drops an id set on a view inside it
                        // (the flows' `tasks-list-title` found nothing on iOS, #1202).
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier(titleIdentifier ?? "kit-header-title")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) { trailing() }
            }
    }
}

/// A sheet's full-width keys (the ink button and the text key under it): the boards draw them 50 tall.
private let sheetButtonHeight: CGFloat = 50

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
    /// Drawn as a text key in the link ink, centred, with no outline (the style sheets' Cancel).
    var link: Bool = false
    /// With `link`: the word is the page's ink, not the app's (the confirm's Cancel, as the Trash
    /// and Cancel-event boards draw it).
    var ink: Bool = false
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
    /// A SHEET THAT TAKES THE HEIGHT OF ITS CONTENT (the band's More, a pick): one detent, the
    /// measured height of the room, and the platform's own sheet ground on iOS 26. A list taller
    /// than the screen scrolls inside it.
    var fit: Bool = false
    /// THE CONTENT IS A LIST OR A SCROLL VIEW THAT SCROLLS ITSELF (#1202): at accessibility sizes the
    /// room is not wrapped in a `ScrollView` of its own, in which a `List` has no height and
    /// collapsed to nothing (the Vaults sheet drew its title over a blank sheet). A sheet that
    /// holds a list says so here; one that holds only fields and rows does not.
    var scrollsItself: Bool = false
    let content: () -> Content

    @Environment(\.colorScheme) private var scheme
    @Environment(\.appAccent) private var accent
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var natural: CGFloat = 0
    @State private var floor: CGFloat = 0

    init(
        title: String,
        status: String = "",
        primary: SheetPrimary? = nil,
        outlines: [SheetOutline] = [],
        titleIdentifier: String = "",
        fit: Bool = false,
        scrollsItself: Bool = false,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.status = status
        self.primary = primary
        self.outlines = outlines
        self.titleIdentifier = titleIdentifier
        self.fit = fit
        self.scrollsItself = scrollsItself
        self.content = content
    }

    var body: some View {
        if fit {
            ScrollView {
                room
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { natural = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            .onGeometryChange(for: CGFloat.self) { $0.safeAreaInsets.bottom } action: { floor = $0 }
            .modifier(SheetPresentation(detents: natural > 0 ? [.height(natural + floor)] : [.medium]))
        } else if dynamicTypeSize.isAccessibilitySize, !scrollsItself {
            // A SHEET TALLER THAN ITS DETENT SCROLLS AT ACCESSIBILITY SIZES (#1202): squeezed into
            // the half sheet, the title was cut to "New entry fo..." and the fields under it with it.
            ScrollView { room }
                .scrollBounceBehavior(.basedOnSize)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .modifier(SheetPresentation())
        } else {
            room
                // THE ROOM FILLS ITS SHEET, top-aligned: sized to its content, it
                // floated mid-sheet as a band of `bgElev` between two slabs of the
                // system's own sheet ground.
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .modifier(SheetPresentation())
        }
    }

    private var room: some View {
        VStack(alignment: .leading, spacing: 12) {
            // A SHEET THAT DRAWS ITS OWN HEAD (the custom repeat's title with Done beside it)
            // passes no title.
            if !title.isEmpty {
                Text(title)
                    .kitType(.section)
                    .foregroundStyle(Surface.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier(titleIdentifier.isEmpty ? "kit-sheet-title" : titleIdentifier)
                    .padding(.top, 20)
            }
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
                        if outline.link {
                            // THE APP'S BLUE, as the board's Cancel: a word, no outline.
                            Button(action: outline.action) {
                                Text(outline.label)
                                    .centraidType("sheetKey")
                                    .foregroundStyle(outline.ink ? Surface.ink : accent.text)
                                    .frame(maxWidth: .infinity, minHeight: sheetButtonHeight)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier(outline.identifier)
                        } else {
                            KitOutlineButton(label: outline.label, tone: outline.tone, action: outline.action)
                                .accessibilityIdentifier(outline.identifier)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
}

/// A ROUTED SCREEN THAT IS A SHEET (`Route.sheet`: Money's target, Photos' picker), as the boards
/// draw it: the X at the leading edge (Cancel, in the bar's own glass), the title between, the
/// page under it and, when the screen has one, a foot pinned to the bottom edge for its verbs.
/// Cancel, a swipe down and a finished screen all close it the same way: the shell drops the
/// sheet and Rust is told the pop.
struct SheetPage<Content: View, Foot: View>: View {
    let title: String
    var cancelLabel: String = KitWords.CANCEL
    let onCancel: () -> Void
    @ViewBuilder let content: () -> Content
    @ViewBuilder let foot: () -> Foot

    var body: some View {
        NavigationStack {
            content()
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .sheetPageGround()
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    foot()
                        .frame(maxWidth: .infinity)
                        .sheetPageGround(edges: .bottom)
                }
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button(action: onCancel) {
                            CentraidIconView(iconKey: "X", tint: Surface.ink, size: 18)
                                .frame(minWidth: 30, minHeight: CentraidGeometry.targetMinCoarse)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(cancelLabel)
                        .accessibilityIdentifier("kit-sheet-cancel")
                    }
                }
        }
        .modifier(SheetPresentation(detents: [.large]))
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
            .modifier(SheetGround())
            .presentationDragIndicator(.visible)
            .presentationDetents(detents)
            // THE TEXT-SIZE CAP, STATED AGAIN: a sheet does not inherit the app
            // root's (see `Theme.textSizeCap`).
            .dynamicTypeSize(...Theme.textSizeCap)
    }
}

/// THE GROUND UNDER EVERY SHEET: the system's own on iOS 26 (Liquid Glass), and the kit's cream
/// `sheet` surface before it. Fixed here, once, so no sheet states its own ground and none
/// lays a slab of its own colour on the glass (the owner's ruling, #1173). UNDER REDUCE
/// TRANSPARENCY OR INCREASE CONTRAST the ground is the `sheet` surface on any version (owner
/// ruling 26, 20 November): the sheet stays compact glass for everyone else, and text on it
/// never sits over a blurred page for a member who asked for none.
private struct SheetGround: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *), !(reduceTransparency || contrast == .increased) {
            content
        } else {
            content.presentationBackground(Surface.sheet)
        }
    }
}

private struct SheetCardGround<S: Shape>: ViewModifier {
    let shape: S
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26, *), !(reduceTransparency || contrast == .increased) {
            content.background(Color(uiColor: .secondarySystemGroupedBackground).opacity(0.6), in: shape)
        } else {
            content.background(Surface.sheetCard, in: shape)
        }
    }
}

private struct SheetPageGround: ViewModifier {
    let edges: Edge.Set
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26, *), !(reduceTransparency || contrast == .increased) {
            content
        } else {
            content.background(Surface.sheet.ignoresSafeArea(edges: edges))
        }
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
    /// A glyph before the label (the lock wall's face or fingerprint); empty for none.
    var iconKey: String = ""
    let action: () -> Void

    @Environment(\.isEnabled) private var enabled
    @Environment(\.appAccent) private var accent
    @ScaledMetric(relativeTo: .body) private var glyph: CGFloat = 20

    /// THE ONE FILLED ELEMENT (#1173): a full-width pill in the app's fill under a white label;
    /// a destructive one is the outlined state-red pill at the same width. Disabled is still
    /// drawn: the fill colour with meta ink, never hidden, never faded.
    private var ink: Color {
        guard enabled else { return Surface.meta }
        return destructive ? StateColor.red.text : .white
    }

    var body: some View {
        Button(action: action) {
            // `sheetKey` IS THE BOARD'S 16/600: `.fontWeight` does not reach a custom face.
            HStack(spacing: 10) {
                if !iconKey.isEmpty {
                    CentraidIconView(iconKey: iconKey, tint: ink, size: min(glyph, 40))
                        .accessibilityHidden(true)
                }
                Text(label)
                    .centraidType("sheetKey")
                    .foregroundStyle(ink)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, minHeight: sheetButtonHeight)
                .background {
                    if !destructive {
                        KitPillShape().fill(enabled ? accent.fill : Surface.fill)
                    }
                }
                .overlay {
                    if destructive {
                        KitPillShape().strokeBorder(enabled ? StateColor.red.text : Surface.border, lineWidth: 1.5)
                    }
                }
                .contentShape(KitPillShape())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier.isEmpty ? (destructive ? "kit-destructive" : "kit-primary") : identifier)
    }
}

extension View {
    /// A SHEET PAGE'S GROUND: the system's glass on iOS 26 (nothing drawn), the kit's `sheet`
    /// surface before it and under Reduce Transparency or Increase Contrast.
    func sheetPageGround(edges: Edge.Set = .all) -> some View {
        modifier(SheetPageGround(edges: edges))
    }

    /// A GROUPED CARD INSIDE A SHEET: on iOS 26 the system's own grouped fill over the glass (no
    /// cream slab), the kit's `sheetCard` before it.
    func sheetCardGround(_ shape: some Shape = RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous)) -> some View {
        modifier(SheetCardGround(shape: shape))
    }

    /// A PAGE THAT SCROLLS UNDER GLASS KEYS WITH CONTENT OF ITS OWN (a hero's round keys) takes a
    /// hard top edge on iOS 26: the content stops at the bar's edge instead of showing through the
    /// glass behind the back and Edit keys. Earlier systems draw no such edge, so nothing changes.
    @ViewBuilder
    func hardTopScrollEdge() -> some View {
        if #available(iOS 26, *) {
            scrollEdgeEffectStyle(.hard, for: .top)
        } else {
            self
        }
    }

    /// THE SCRIM UNDER THE BAND: on iOS 26 the content that scrolls beneath the glass band takes a
    /// soft edge (a fade into the page), so a row's text never runs through the keys. Earlier
    /// systems draw the band on the page's own strip (`BandStrip`), so nothing changes.
    @ViewBuilder
    func softBottomScrollEdge() -> some View {
        if #available(iOS 26, *) {
            scrollEdgeEffectStyle(.soft, for: .bottom)
        } else {
            self
        }
    }
}
