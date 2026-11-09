import SwiftUI

/// LINKS SET BY HAND (#1173, O3): the one section and the one picker sheet that Money's "With",
/// Photos' "People in this photo", Docs' "About" and Locker's "Linked to" share. Rust makes every
/// word and row (`LinkSection`, `LinkPicker`); this draws them and sends the member's taps back as
/// a `LinkEvent`. The Compose twin is `kit/LinkViews.kt`.

private func linkEvent(_ build: (inout Centraid_Core_V1_LinkEvent) -> Void) -> Centraid_Core_V1_LinkEvent {
    var event = Centraid_Core_V1_LinkEvent()
    build(&event)
    return event
}

/// A titled card of linked things, each with a key to take the link off, then the add rows.
struct LinkSectionView: View {
    let section: Centraid_Core_V1_LinkSection
    let send: (Centraid_Core_V1_LinkEvent) -> Void
    var open: ((Centraid_Core_V1_Route) -> Void)? = nil
    /// The page margin around the card; a section placed inside a card column of its own turns it off.
    var padded = true

    @Environment(\.appAccent) private var accent

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionHeader(title: section.title)
                .accessibilityIdentifier("link-section-title")
            VStack(spacing: 0) {
                ForEach(Array(section.rows.enumerated()), id: \.offset) { index, row in
                    if index > 0 { KitHairline(inset: 16) }
                    linkRow(row)
                }
                if section.rows.isEmpty, !section.empty.isEmpty {
                    Text(section.empty)
                        .kitType(.row)
                        .foregroundStyle(Surface.meta)
                        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
                        .padding(.horizontal, 14)
                }
                ForEach(Array(section.adds.enumerated()), id: \.offset) { index, add in
                    if index > 0 || !section.rows.isEmpty { KitHairline(inset: 16) }
                    Button { send(linkEvent { $0.add = .with { $0.key = add.key } }) } label: {
                        HStack(spacing: 12) {
                            CentraidIconView(iconKey: "add", tint: accent.text, size: 18)
                                .frame(width: 32, height: 32)
                            Text(add.label)
                                .kitType(.row)
                                .fontWeight(.semibold)
                                .foregroundStyle(accent.text)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 14)
                        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("link-add-\(add.key)")
                }
            }
            .kitCard()
        }
        .padding(.horizontal, padded ? CentraidGeometry.pageMargin : 0)
        .padding(.top, padded ? 8 : 0)
    }

    @ViewBuilder
    private func linkRow(_ row: Centraid_Core_V1_LinkRow) -> some View {
        HStack(spacing: 12) {
            Button {
                if row.hasRoute { open?(row.route) }
            } label: {
                HStack(spacing: 12) {
                    LinkInitial(text: row.title)
                    VStack(alignment: .leading, spacing: 1) {
                        if !row.meta.isEmpty {
                            Text(row.meta).kitType(.meta).foregroundStyle(Surface.meta)
                        }
                        Text(row.title).kitType(.row).foregroundStyle(Surface.ink).lineLimit(2)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!row.hasRoute || open == nil)
            if !row.removeLabel.isEmpty {
                Button { send(linkEvent { $0.remove = .with { $0.id = row.id } }) } label: {
                    CentraidIconView(iconKey: "X", tint: Surface.meta, size: 16)
                        .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(row.removeLabel)
                .accessibilityIdentifier("link-remove-\(row.id)")
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 4)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
        .accessibilityIdentifier("link-row-\(row.id)")
    }
}

/// The first letter of a name in a quiet circle: no photograph is ever fetched for a link.
struct LinkInitial: View {
    let text: String
    @Environment(\.appAccent) private var accent

    var body: some View {
        Text(String(text.prefix(1)).uppercased())
            .kitType(.meta)
            .fontWeight(.semibold)
            .foregroundStyle(accent.text)
            .frame(width: 32, height: 32)
            .background(accent.fill.opacity(0.12), in: Circle())
            .accessibilityHidden(true)
    }
}

/// THE PICKER SHEET: search by name, tap a row to link it, tap a linked one to unlink it.
struct LinkPickerSheet: View {
    let picker: Centraid_Core_V1_LinkPicker
    let send: (Centraid_Core_V1_LinkEvent) -> Void

    var body: some View {
        SheetRoom(title: picker.title, titleIdentifier: "link-picker") {
            MachineTextField(
                placeholder: picker.placeholder,
                value: picker.query,
                focusOnAppear: false
            ) { text in send(linkEvent { $0.query = .with { $0.text = text } }) }
                .kitType(.row)
                .padding(.horizontal, 14)
                .frame(minHeight: CentraidGeometry.targetMinCoarse)
                .kitCard()
                .accessibilityIdentifier("link-picker-search")
            if picker.candidates.isEmpty {
                Text(picker.empty)
                    .kitType(.row)
                    .foregroundStyle(Surface.meta)
                    .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
                    .accessibilityIdentifier("link-picker-empty")
            } else {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(picker.candidates, id: \.id) { row in
                            SheetRow(
                                label: row.title,
                                detail: row.meta,
                                selected: row.selected,
                                identifier: "link-pick-\(row.id)"
                            ) { send(linkEvent { $0.pick = .with { $0.id = row.id } }) }
                        }
                    }
                }
            }
        }
    }
}

extension View {
    /// The picker as a sheet over the page, open while Rust says so; a swipe down is `closed`.
    func linkPickerSheet(
        _ picker: Centraid_Core_V1_LinkPicker,
        send: @escaping (Centraid_Core_V1_LinkEvent) -> Void
    ) -> some View {
        sheet(isPresented: Binding(
            get: { picker.open },
            set: { open in if !open && picker.open { send(linkEvent { $0.closed = .init() }) } }
        )) {
            LinkPickerSheet(picker: picker, send: send)
        }
    }
}
