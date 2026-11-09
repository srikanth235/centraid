import SwiftUI

import UIKit

// THE SEARCH FIELD, ONCE (K5). Lifted from `PhotosSearchBar`. `BandSearchField` is the field
// every app place opens at the foot, in the band's place; `CentraidSearchField` is the one
// Home's search page and Chat's drawer open under their headers.

/// One of the search row's round controls: 48, on the band's glass (`bandGround`) — the band's
/// own materials at the system's size.
struct SearchCircle: View {
    let iconKey: String
    let spoken: String
    let identifier: String
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: action) {
            CentraidIconView(iconKey: iconKey, tint: Theme.color("text", scheme), size: 20)
                .frame(width: BandMetrics.searchHeight, height: BandMetrics.searchHeight)
                .bandGround(Circle(), solid: "bg", interactive: true)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(spoken)
        .accessibilityIdentifier(identifier)
    }
}

/// A TEXT FIELD WITH NOTHING OVER THE KEYBOARD.
///
/// Suggestions, autocorrection, spell-checking, inline predictions, smart
/// punctuation and the assistant bar's button groups are all off — the
/// combination UIKit needs before it drops the strip. The Search key ends
/// editing (the row then moves into the band's slot); focus is a binding both
/// ways, so SwiftUI can raise the keyboard and the keyboard's own dismissal
/// reaches SwiftUI.
struct BareSearchField: UIViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    let placeholder: String
    let font: UIFont
    let color: UIColor
    let placeholderColor: UIColor
    /// The Search key, after it puts the keyboard away; nil for a field whose
    /// query is simply live.
    var onSubmit: (() -> Void)? = nil

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.font = font
        field.textColor = color
        field.attributedPlaceholder = NSAttributedString(
            string: placeholder,
            attributes: [.foregroundColor: placeholderColor, .font: font]
        )
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.autocapitalizationType = .none
        field.smartDashesType = .no
        field.smartQuotesType = .no
        field.smartInsertDeleteType = .no
        field.inlinePredictionType = .no
        field.returnKeyType = .search
        field.inputAssistantItem.leadingBarButtonGroups = []
        field.inputAssistantItem.trailingBarButtonGroups = []
        field.delegate = context.coordinator
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return field
    }

    func updateUIView(_ field: UITextField, context: Context) {
        context.coordinator.parent = self
        if field.text != text { field.text = text }
        // THE FONT FOLLOWS THE SYSTEM TEXT SIZE: `makeUIView` set it once, and a
        // setting changed while the field is on screen arrives here.
        if field.font != font {
            field.font = font
            field.attributedPlaceholder = NSAttributedString(
                string: placeholder,
                attributes: [.foregroundColor: placeholderColor, .font: font]
            )
        }
        if focused, !field.isFirstResponder {
            DispatchQueue.main.async { field.becomeFirstResponder() }
        } else if !focused, field.isFirstResponder {
            DispatchQueue.main.async { field.resignFirstResponder() }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: BareSearchField
        init(parent: BareSearchField) { self.parent = parent }

        @objc func changed(_ field: UITextField) { parent.text = field.text ?? "" }

        func textFieldDidBeginEditing(_ field: UITextField) {
            if !parent.focused { parent.focused = true }
        }

        func textFieldDidEndEditing(_ field: UITextField) {
            if parent.focused { parent.focused = false }
        }

        /// The Search key: the query is already live, so it only puts the
        /// keyboard away and lets the member look at what it found.
        func textFieldShouldReturn(_ field: UITextField) -> Bool {
            field.resignFirstResponder()
            parent.onSubmit?()
            return false
        }
    }
}
/// WHAT THE SEARCH FIELD DRAWS OF A SCREEN'S SEARCH: whether it is open, the term
/// Rust holds, and the correction it searched instead (empty for none), with Rust's
/// finished "Including results for ..." sentence where the screen's state carries one
/// (Chat's drawer, Docs). Every value is the state's; the page copies them in.
struct KitSearchField {
    var open = false
    var term = ""
    var corrected = ""
    var correctedLabel = ""
}

/// THE SEARCH FIELD AN APP PLACE OPENS UNDER ITS HEADER (K5).
///
/// Its state is the machine's `SearchField`; the text a member types lives
/// here first (the only place a keystroke exists before it is sent) and each
/// DIFFERENCE from the state's term goes to `onTerm` — comparing is what keeps
/// the field from re-sending the term the reducer just published back to it.
/// Close is its own event, and Rust clears the term and its answer with it.
struct CentraidSearchField: View {
    let field: KitSearchField
    let placeholder: String
    var closeLabel: String = KitWords.CLOSE_SEARCH
    var identifier: String = "kit-search"
    /// A quiet scope at the field's end ("All apps"), or none.
    var scope: String = ""
    /// Whether the field carries its own close key. A page whose header has a
    /// Cancel of its own (Home's search) leaves it off.
    var closes: Bool = true
    /// The keyboard's Search key, or nil when the query is simply live.
    var onSubmit: (() -> Void)? = nil
    let onTerm: (String) -> Void
    let onClose: () -> Void

    @State private var typed = ""
    @State private var focused = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        // THE LINE UNDER THE FIELD is where the correction is said (#1097): this
        // field is the one every app's search slot, Home's search and every app's
        // search page draw, so "Including results for ..." is drawn once, here.
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                HStack(spacing: 8) {
                    CentraidIconView(iconKey: "Search", tint: Theme.color("textSoft", scheme), size: BandMetrics.searchGlyph)
                        .frame(width: BandMetrics.searchGlyph, height: BandMetrics.searchGlyph)
                    BareSearchField(
                        text: $typed,
                        focused: $focused,
                        placeholder: placeholder,
                        font: Theme.uiFont("body", scheme, dynamicTypeSize),
                        color: UIColor(Theme.color("text", scheme)),
                        placeholderColor: UIColor(Theme.color("textFaint", scheme)),
                        onSubmit: onSubmit
                    )
                    .accessibilityIdentifier("\(identifier)-field")
                    if !scope.isEmpty, typed.isEmpty {
                        Text(scope)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .lineLimit(1)
                            .fixedSize()
                            .padding(.trailing, 8)
                    }
                    // ONE WAY TO CLEAR OR LEAVE: a field with its own close key closes (the
                    // term goes with it); the inline clear is for a field that has none.
                    if !typed.isEmpty, !closes {
                        Button {
                            typed = ""
                        } label: {
                            CentraidIconView(iconKey: "XCircle", tint: Theme.color("textFaint", scheme), size: 18)
                                .frame(minWidth: CentraidGeometry.targetMinFine, minHeight: CentraidGeometry.targetMinFine)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Clear search")
                    }
                }
                .padding(.leading, BandMetrics.searchGlyphLead)
                .padding(.trailing, 4)
                .frame(height: 40)
                .background(Capsule().fill(Theme.color("bgSunken", scheme)))
                .contentShape(Capsule())
                .onTapGesture { focused = true }
                if closes {
                    Button(action: onClose) {
                        CentraidIconView(iconKey: "X", tint: Theme.color("textSoft", scheme), size: 16)
                            .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(closeLabel)
                    .accessibilityIdentifier("\(identifier)-close")
                }
            }
            if !field.corrected.isEmpty {
                // Rust's sentence where the state carries it; the other screens' states carry the bare
                // term (a Rust gap), so the generated words compose it for them.
                Text(field.correctedLabel.isEmpty ? KitWords.searchCorrected(corrected: field.corrected) : field.correctedLabel)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .lineLimit(2)
                    .padding(.leading, BandMetrics.searchGlyphLead)
                    .accessibilityIdentifier("search-corrected")
            }
        }
        .onAppear {
            typed = field.term
            focused = true
        }
        // A TERM THE MACHINE SET (a recent search picked) reaches the field —
        // only while the field still shows the term it replaced, so a reducer
        // a keystroke behind never takes typed letters back.
        .onChange(of: field.term) { old, new in
            if typed == old, typed != new { typed = new }
        }
        .onChange(of: typed) { _, term in
            guard term != field.term else { return }
            onTerm(term)
        }
    }
}


/// THE SEARCH FIELD AT THE FOOT: an app place's open search, drawn in the band's place.
///
/// A 48 glass field (`bandGround`, the band's own glass) and, at its trailing end, a 48 glass
/// ✕ — the same circle the band's search key was, so the key turns into the way out. While the
/// keyboard is up the row rides it, 8 from the screen's sides and 8 above the keys, as the
/// system Photos app draws it; with the keyboard away (the Search key) it moves into the band's
/// slot, `floor` from the glass, so the foot is never a blank and the results stay in view.
///
/// Its state is the machine's `SearchField`, as `CentraidSearchField`'s is: the text a member
/// types lives here first and each DIFFERENCE from the state's term goes to `onTerm`. Close is
/// its own event, and Rust clears the term and its answer with it; this puts the keyboard away
/// first. The correction line ("Including results for ...", #1097) stands directly over the
/// field, because the field is at the foot and the line is read with it.
struct BandSearchField: View {
    let field: KitSearchField
    let placeholder: String
    var closeLabel: String = KitWords.CLOSE_SEARCH
    var identifier: String = "kit-search"
    /// A page whose close only CLEARS the query (Money's search page, which the member leaves
    /// by its back key) keeps the keyboard; everywhere else the close puts it away.
    var keepsFocusOnClose = false
    let onTerm: (String) -> Void
    let onClose: () -> Void
    /// The Search key, for a page that records the search when it is submitted.
    var onSubmit: (() -> Void)? = nil

    @State private var typed = ""
    @State private var focused = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !field.corrected.isEmpty {
                Text(field.correctedLabel.isEmpty ? KitWords.searchCorrected(corrected: field.corrected) : field.correctedLabel)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .lineLimit(2)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 4)
                    .bandGround(Capsule(), solid: "bgElev")
                    .padding(.leading, BandMetrics.searchGlyphLead)
                    .accessibilityIdentifier("search-corrected")
            }
            BandGlassGroup(spacing: BandMetrics.groupSpacing) {
                HStack(spacing: focused ? BandMetrics.searchInset : BandMetrics.searchRestGap) {
                    fieldCapsule
                    SearchCircle(iconKey: "X", spoken: closeLabel, identifier: "\(identifier)-close") {
                        if !keepsFocusOnClose { focused = false }
                        onClose()
                    }
                }
            }
        }
        .padding(.horizontal, focused ? BandMetrics.searchInset : BandMetrics.inset + BandMetrics.searchRestPad)
        .padding(.vertical, focused ? 0 : BandMetrics.searchRestPad)
        .padding(.top, BandMetrics.topGap)
        // Over the keyboard while typing; in the band's slot, `floor` from the glass, when not.
        .padding(.bottom, focused ? BandMetrics.searchInset : BandMetrics.floorPadding)
        .animation(
            reduceMotion
                ? nil
                : .timingCurve(0.3, 0, 0.4, 1, duration: CentraidGeometry.durationOne / 1000),
            value: focused
        )
        .onAppear {
            // THE FIELD OPENS READY: a member who pressed the key wants to type.
            typed = field.term
            focused = true
        }
        // A TERM THE MACHINE SET reaches the field only while the field still shows the term it
        // replaced, so a reducer a keystroke behind never takes typed letters back.
        .onChange(of: field.term) { old, new in
            if typed == old, typed != new { typed = new }
        }
        .onChange(of: typed) { _, term in
            guard term != field.term else { return }
            onTerm(term)
        }
    }

    private var fieldCapsule: some View {
        HStack(spacing: BandMetrics.searchTextLead - BandMetrics.searchGlyphLead - BandMetrics.searchGlyph) {
            CentraidIconView(iconKey: "Search", tint: Theme.color("textSoft", scheme), size: BandMetrics.searchGlyph)
                .frame(width: BandMetrics.searchGlyph, height: BandMetrics.searchGlyph)
            BareSearchField(
                text: $typed,
                focused: $focused,
                placeholder: placeholder,
                font: Theme.uiFont("body", scheme, dynamicTypeSize),
                color: UIColor(Theme.color("text", scheme)),
                placeholderColor: UIColor(Theme.color("textFaint", scheme)),
                onSubmit: onSubmit
            )
            .accessibilityIdentifier("\(identifier)-field")
            if !typed.isEmpty {
                Button {
                    typed = ""
                } label: {
                    CentraidIconView(iconKey: "XCircle", tint: Theme.color("textFaint", scheme), size: 18)
                        .frame(minWidth: CentraidGeometry.targetMinFine, minHeight: CentraidGeometry.targetMinFine)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.leading, BandMetrics.searchGlyphLead)
        .padding(.trailing, 4)
        .frame(height: BandMetrics.searchHeight)
        .bandGround(Capsule(), solid: "bgElev")
        .contentShape(Capsule())
        // A tap anywhere on the capsule, not only on the text run, starts typing again.
        .onTapGesture { focused = true }
    }
}
