import SwiftUI

/// THE KEYBOARD TOOLBAR OVER A QUICK ADD (#1173): Date, Tag and Flag, drawn on the keyboard while the
/// quick add's field has it. Each key stages what the next add carries; Return adds it and keeps the
/// keyboard. One component for the project page and Agenda's To-do.
///
/// **THE VIEW DECIDES NOTHING.** The keys, their icons, whether each is lit (`on`), the chips under
/// Date, the tag field's placeholder and the staged sentence are all `TodoQuickAdd`'s; a tap sends the
/// key, and Rust answers with the next state. The plate is Liquid Glass on iOS 26 and the solid card
/// before it (`bandGround`, the band's one rule).
struct QuickAddToolbar: View {
    let quickAdd: Centraid_Core_V1_TodoQuickAdd
    let onTool: (String) -> Void
    let onDue: (String) -> Void
    let onTag: (String) -> Void

    @Environment(\.colorScheme) private var scheme
    /// THE MEMBER'S TYPING in the tag field, cleared when it is sent.
    @State private var typedTag = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if quickAdd.openTool == "date" {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(quickAdd.dueChoices, id: \.key) { choice in
                            KitChip(
                                label: choice.label,
                                selected: choice.selected,
                                identifier: "agenda-quick-due-\(choice.key)"
                            ) { onDue(choice.key) }
                                .disabled(!choice.enabled)
                        }
                    }
                }
            }
            if quickAdd.openTool == "tag" {
                TextField(quickAdd.tagPlaceholder, text: $typedTag)
                    .centraidType("small")
                    .submitLabel(.done)
                    .onSubmit {
                        let text = typedTag.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !text.isEmpty else { return }
                        typedTag = ""
                        onTag(text)
                    }
                    .frame(minHeight: CentraidGeometry.targetMinCoarse)
                    .accessibilityLabel(quickAdd.tagPlaceholder)
                    .accessibilityIdentifier("agenda-quick-tag-field")
            }
            HStack(spacing: 0) {
                ForEach(quickAdd.tools, id: \.key) { tool in
                    KitIconKey(
                        iconKey: tool.iconKey,
                        label: tool.label,
                        tint: tool.on ? "accent" : "textSoft",
                        solid: tool.on,
                        identifier: "agenda-quick-tool-\(tool.key)"
                    ) { onTool(tool.key) }
                        .accessibilityAddTraits(tool.on ? .isSelected : [])
                }
                Spacer(minLength: 0)
            }
            if !quickAdd.stagedLabel.isEmpty {
                Text(quickAdd.stagedLabel)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .accessibilityIdentifier("agenda-quick-staged")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .bandGround(RoundedRectangle(cornerRadius: Theme.radius("md", scheme)), solid: "bgSunken")
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 6)
    }
}
