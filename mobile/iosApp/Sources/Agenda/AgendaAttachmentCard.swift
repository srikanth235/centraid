import SwiftUI

struct AgendaAttachmentCard: View {
    let value: Centraid_Core_V1_AgendaAttachments
    let send: (Centraid_Core_V1_AgendaAttachmentEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader(title: value.heading)
            ForEach(value.rows, id: \.id) { row in
                HStack(spacing: 4) {
                    VStack(alignment: .leading, spacing: 0) {
                    SheetRow(iconKey: "Paperclip", label: row.title, chevron: true, identifier: "agenda-attachment-\(row.id)") { if row.hasRoute { open(row.route) } }
                    Text(row.meta).centraidType("small").foregroundStyle(Theme.color("textSoft", scheme)).padding(.leading, 36)
                    }
                    KitIconKey(iconKey: "X", label: value.removeLabel, identifier: "agenda-attachment-remove-\(row.id)") {
                        send(.with { $0.remove = .with { $0.id = row.id } })
                    }.disabled(value.busy)
                }.padding(.horizontal, 12)
            }
            KitLink(label: value.addLabel, identifier: "agenda-attachment-add") { send(.with { $0.add = .init() }) }
                .disabled(value.busy).padding(.horizontal, 8)
            KitLink(label: value.addPhotoLabel, identifier: "agenda-attachment-add-photo") { send(.with { $0.addPhoto = .init() }) }
                .disabled(value.busy).padding(.horizontal, 8)
            StatusLineView(status: value.status, identifier: "agenda-attachment-retry") { send(.with { $0.retry = .init() }) }
        }
        .padding(.vertical, 8)
        .background(Theme.color("bgElev", scheme), in: RoundedRectangle(cornerRadius: Theme.radius("lg", scheme)))
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
    }
}
