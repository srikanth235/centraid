import SwiftUI

/// The saved palette and icon choices arrive with their words and selection from Rust.
struct AgendaAppearancePicker: View {
    let value: Centraid_Core_V1_AgendaAppearance
    let change: (Centraid_Core_V1_AgendaFormChanged) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader(title: value.colorLabel)
            ForEach(value.colors, id: \.key) { choice in
                HStack(spacing: 12) {
                    Circle().fill(Theme.color(choice.key, scheme)).frame(width: 16, height: 16)
                    SheetRow(label: choice.label, selected: choice.selected, identifier: "agenda-color-\(choice.key)") {
                        change(.with { $0.field = "color"; $0.value = choice.key })
                    }
                }
            }
            SectionHeader(title: value.iconLabel)
            ForEach(value.icons, id: \.key) { choice in
                SheetRow(iconKey: choice.iconKey, label: choice.label, selected: choice.selected, identifier: "agenda-icon-\(choice.key)") {
                    change(.with { $0.field = "icon"; $0.value = choice.key })
                }
            }
        }
    }
}

struct AgendaCalendarForm: View {
    let value: Centraid_Core_V1_AgendaContainerForm
    let status: String
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void
    var body: some View {
        SheetRoom(title: value.title, status: status, primary: value.canSave ? SheetPrimary(label: value.saveLabel) { send(.with { $0.containerSaved = .init() }) } : nil) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    MachineTextField(placeholder: value.nameLabel, value: value.name, focusOnAppear: true, onEdit: { name in
                        send(.with { $0.containerForm = .with { $0.field = "name"; $0.value = name } })
                    })
                    .centraidType("body")
                    .accessibilityLabel(value.nameLabel)
                    .accessibilityIdentifier("agenda-calendar-name")
                    AgendaAppearancePicker(value: value.appearance) { changed in send(.with { $0.containerForm = changed }) }
                }
            }
        }
    }
}

struct AgendaImportOptionsView: View {
    let value: Centraid_Core_V1_AgendaImportOptions
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void
    var body: some View {
        SheetRoom(title: value.title) {
            VStack(alignment: .leading, spacing: 0) {
                Toggle(value.includeCompletedLabel, isOn: Binding(get: { value.includeCompleted }, set: { on in
                    send(.with { $0.importOptions = .with { $0.includeCompleted = on } })
                })).kitToggle().accessibilityIdentifier("agenda-import-completed")
                ForEach(value.options, id: \.key) { option in
                    SheetRow(label: option.label, identifier: "agenda-import-\(option.key)") {
                        send(.with { $0.importRequested = .with { $0.source = option.source; $0.includeCompleted = value.includeCompleted; $0.fromFile = option.fromFile } })
                    }
                }
            }
        }
    }
}
