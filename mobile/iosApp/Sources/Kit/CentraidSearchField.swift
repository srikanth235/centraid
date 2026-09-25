import SwiftUI
import UIKit

// THE SEARCH FIELD, ONCE (K5). Lifted from `PhotosSearchBar`, which still draws
// the Photos band-slot variant from these two pieces; `CentraidSearchField` below
// is the field every other app place opens under its header.

/// One of the search row's round controls: 48, on the elevated ground, with a
/// hairline — the band's own materials at the system's size.
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
                .background(Circle().fill(Theme.color("bgElev", scheme)))
                .overlay(
                    Circle().strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
                )
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
            return false
        }
    }
}
/// THE SEARCH FIELD AN APP PLACE OPENS UNDER ITS HEADER (K5).
///
/// Its state is the machine's `SearchField`; the text a member types lives
/// here first (the only place a keystroke exists before it is sent) and each
/// DIFFERENCE from the state's term goes to `onTerm` — comparing is what keeps
/// the field from re-sending the term the reducer just published back to it.
/// Close is its own event, and the kit's `SearchLaw.closed` clears the term
/// and its answer with it.
struct CentraidSearchField: View {
    let field: Centraid_Screen_V1_SearchField
    let placeholder: String
    var closeLabel: String = "Close search"
    var identifier: String = "kit-search"
    let onTerm: (String) -> Void
    let onClose: () -> Void

    @State private var typed = ""
    @State private var focused = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 8) {
                CentraidIconView(iconKey: "Search", tint: Theme.color("textSoft", scheme), size: BandMetrics.searchGlyph)
                    .frame(width: BandMetrics.searchGlyph, height: BandMetrics.searchGlyph)
                BareSearchField(
                    text: $typed,
                    focused: $focused,
                    placeholder: placeholder,
                    font: Theme.uiFont("body", scheme),
                    color: UIColor(Theme.color("text", scheme)),
                    placeholderColor: UIColor(Theme.color("textFaint", scheme))
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
            .frame(height: 40)
            .background(Capsule().fill(Theme.color("bgSunken", scheme)))
            .contentShape(Capsule())
            .onTapGesture { focused = true }
            Button(action: onClose) {
                CentraidIconView(iconKey: "X", tint: Theme.color("textSoft", scheme), size: 16)
                    .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(closeLabel)
            .accessibilityIdentifier("\(identifier)-close")
        }
        .onAppear {
            typed = field.term
            focused = true
        }
        .onChange(of: typed) { _, term in
            guard term != field.term else { return }
            onTerm(term)
        }
    }
}
