import SwiftUI

struct RoomFormBlock: View {
    let form: Centraid_Core_V1_RoomForm
    let callbacks: RoomCallbacks

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(form.fields.enumerated()), id: \.offset) { _, field in
                RoomFieldView(field: field, callbacks: callbacks)
            }
            ForEach(Array(form.repeats.enumerated()), id: \.offset) { _, rep in
                RoomRepeatView(repeatGroup: rep, callbacks: callbacks)
            }
            switch form.save {
            case .autosave(let autosave)?:
                RoomAutosaveRow(autosave: autosave, onTap: callbacks.tap)
            case .explicit(let explicit)?:
                RoomExplicitSaveRow(explicit: explicit, onTap: callbacks.tap)
            case nil:
                EmptyView()
            }
        }
        .padding(.vertical, 8)
    }
}

struct RoomFieldView: View {
    let field: Centraid_Core_V1_RoomField
    let callbacks: RoomCallbacks

    @State private var seq: UInt64 = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            switch field.input {
            case .text(let text)?:
                RoomTextField(
                    selectorID: field.selectorID,
                    label: field.label,
                    hint: field.hint,
                    error: field.error,
                    focusedOnAppear: field.focused,
                    text: text,
                    onEdit: { nextSeq, value in
                        callbacks.change(field.selectorID, nextSeq, .text(value))
                    },
                    onTap: callbacks.tap
                )
                .padding(.horizontal, CentraidGeometry.pageMargin)

            case .money(let money)?:
                RoomMoneyField(
                    selectorID: field.selectorID,
                    label: field.label,
                    error: field.error,
                    focusedOnAppear: field.focused,
                    money: money,
                    onMinor: { nextSeq, minor in
                        callbacks.change(field.selectorID, nextSeq, .integer(minor))
                    }
                )
                .padding(.horizontal, CentraidGeometry.pageMargin)

            case .moment(let moment)?:
                RoomMomentField(
                    selectorID: field.selectorID,
                    label: field.label,
                    error: field.error,
                    moment: moment,
                    onChange: { nextSeq, value in
                        callbacks.change(field.selectorID, nextSeq, .moment(value))
                    }
                )
                .padding(.horizontal, CentraidGeometry.pageMargin)

            case .choice(let choice)?:
                RoomChoiceBlock(choice: choice, callbacks: callbacks)

            case .toggle(let toggle)?:
                Toggle(
                    isOn: Binding(
                        get: { toggle.on },
                        set: { value in
                            seq &+= 1
                            callbacks.change(field.selectorID, seq, .flag(value))
                        }
                    )
                ) {
                    Text(field.label)
                        .kitType(.row)
                        .foregroundStyle(Surface.ink)
                }
                .kitToggle()
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .frame(minHeight: CentraidGeometry.targetMinCoarse)
                .accessibilityIdentifier(field.selectorID)

            case .item(let pick)?:
                RoomPickField(
                    selectorID: field.selectorID,
                    label: field.label,
                    display: pick.display.isEmpty ? field.hint : pick.display,
                    clearSelectorID: pick.clearSelectorID_p,
                    error: field.error,
                    onTap: callbacks.tap
                )
                .padding(.horizontal, CentraidGeometry.pageMargin)

            case .file(let pick)?:
                RoomPickField(
                    selectorID: field.selectorID,
                    label: field.label,
                    display: pick.display.isEmpty ? field.hint : pick.display,
                    clearSelectorID: pick.clearSelectorID_p,
                    error: field.error,
                    onTap: callbacks.tap
                )
                .padding(.horizontal, CentraidGeometry.pageMargin)

            case .secret(let secret)?:
                RoomSecretField(
                    selectorID: field.selectorID,
                    label: field.label,
                    hint: field.hint,
                    error: field.error,
                    focusedOnAppear: field.focused,
                    secret: secret,
                    onEdit: { nextSeq, value in
                        callbacks.change(field.selectorID, nextSeq, .text(value))
                    },
                    onTap: callbacks.tap
                )
                .padding(.horizontal, CentraidGeometry.pageMargin)

            case nil:
                EmptyView()
            }
        }
    }
}

private enum RoomMomentCodec {
    private static func makeFormatter(_ format: String, zone: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone.isEmpty ? .current : (TimeZone(identifier: zone) ?? .current)
        formatter.dateFormat = format
        return formatter
    }

    static func parse(_ value: String, kind: Centraid_Core_V1_RoomMomentKind, zone: String) -> Date {
        guard !value.isEmpty else { return Date() }
        let format: String
        switch kind {
        case .time: format = "HH:mm"
        case .dayTime: format = "yyyy-MM-dd'T'HH:mm"
        case .day, .unspecified, .UNRECOGNIZED: format = "yyyy-MM-dd"
        }
        return makeFormatter(format, zone: zone).date(from: value) ?? Date()
    }

    static func encode(_ date: Date, kind: Centraid_Core_V1_RoomMomentKind, zone: String) -> String {
        let format: String
        switch kind {
        case .time: format = "HH:mm"
        case .dayTime: format = "yyyy-MM-dd'T'HH:mm"
        case .day, .unspecified, .UNRECOGNIZED: format = "yyyy-MM-dd"
        }
        return makeFormatter(format, zone: zone).string(from: date)
    }
}

private struct RoomMomentField: View {
    let selectorID: String
    let label: String
    let error: String
    let moment: Centraid_Core_V1_RoomMoment
    let onChange: (UInt64, String) -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var date = Date()
    @State private var sync = RoomTextSync()

    private var components: DatePickerComponents {
        switch moment.kind {
        case .time: return [.hourAndMinute]
        case .dayTime: return [.date, .hourAndMinute]
        case .day, .unspecified, .UNRECOGNIZED: return [.date]
        }
    }

    private var selection: Binding<Date> {
        Binding(
            get: { date },
            set: { next in
                date = next
                let encoded = RoomMomentCodec.encode(next, kind: moment.kind, zone: moment.zone)
                let seq = sync.nextSeq()
                onChange(seq, encoded)
            }
        )
    }

    @ViewBuilder
    private var clearButton: some View {
        if moment.clearable, !moment.value.isEmpty {
            KitIconKey(
                iconKey: "X",
                label: KitWords.DISMISS,
                identifier: "\(selectorID)-clear",
                action: {
                    let seq = sync.nextSeq()
                    onChange(seq, "")
                }
            )
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if dynamicTypeSize >= Theme.reflowSize {
                VStack(alignment: .leading, spacing: 6) {
                    Text(label)
                        .kitType(.row)
                        .foregroundStyle(Surface.ink)
                        .accessibilityHidden(true)
                    HStack {
                        DatePicker("", selection: selection, displayedComponents: components)
                            .labelsHidden()
                            .kitType(.row)
                            .foregroundStyle(Surface.ink)
                            .accessibilityLabel(label)
                            .accessibilityIdentifier(selectorID)
                        Spacer(minLength: 0)
                        clearButton
                    }
                }
            } else {
                HStack {
                    DatePicker(
                        label,
                        selection: selection,
                        displayedComponents: components
                    )
                    .kitType(.row)
                    .foregroundStyle(Surface.ink)
                    .accessibilityLabel(label)
                    .accessibilityIdentifier(selectorID)
                    clearButton
                }
            }
            if !error.isEmpty {
                Text(error)
                    .kitType(.meta)
                    .foregroundStyle(StateColor.red.text)
            }
        }
        .onAppear {
            date = RoomMomentCodec.parse(moment.value, kind: moment.kind, zone: moment.zone)
        }
        .onChange(of: moment.value) { _, next in
            date = RoomMomentCodec.parse(next, kind: moment.kind, zone: moment.zone)
        }
    }
}

private struct RoomPickField: View {
    let selectorID: String
    let label: String
    let display: String
    let clearSelectorID: String
    let error: String
    let onTap: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !label.isEmpty {
                Text(label)
                    .kitType(.meta)
                    .foregroundStyle(Surface.body)
            }
            HStack(spacing: 8) {
                Button { onTap(selectorID) } label: {
                    HStack {
                        Text(display)
                            .kitType(.row)
                            .foregroundStyle(Surface.ink)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        CentraidIconView(iconKey: "ChevronRight", tint: Surface.meta, size: 14)
                    }
                    .padding(.horizontal, 12)
                    .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
                    .background(Surface.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(Surface.border, lineWidth: CentraidGeometry.hairline)
                    )
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier(selectorID)

                if !clearSelectorID.isEmpty {
                    KitIconKey(
                        iconKey: "X",
                        label: KitWords.DISMISS,
                        identifier: clearSelectorID,
                        action: { onTap(clearSelectorID) }
                    )
                }
            }
            if !error.isEmpty {
                Text(error)
                    .kitType(.meta)
                    .foregroundStyle(StateColor.red.text)
            }
        }
    }
}

private struct RoomSecretField: View {
    let selectorID: String
    let label: String
    let hint: String
    let error: String
    let focusedOnAppear: Bool
    let secret: Centraid_Core_V1_RoomSecret
    let onEdit: (UInt64, String) -> Void
    let onTap: (String) -> Void

    @State private var typed = ""
    @State private var sync = RoomTextSync()
    @FocusState private var isFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !label.isEmpty {
                Text(label)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
            }
            HStack(spacing: 8) {
                Group {
                    if secret.masked {
                        SecureField(hint, text: $typed)
                    } else {
                        TextField(hint, text: $typed)
                            .autocorrectionDisabled(true)
                            .textInputAutocapitalization(.never)
                    }
                }
                .focused($isFocused)
                .kitType(.row)
                .foregroundStyle(Surface.ink)
                .padding(.horizontal, 12)
                .frame(minHeight: CentraidGeometry.targetMinCoarse)
                .background(Surface.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(Surface.border, lineWidth: CentraidGeometry.hairline)
                )
                .accessibilityIdentifier(selectorID)

                if !secret.revealSelectorID.isEmpty {
                    KitIconKey(
                        iconKey: "Eye",
                        label: label,
                        identifier: secret.revealSelectorID,
                        action: { onTap(secret.revealSelectorID) }
                    )
                }
            }
            if !error.isEmpty {
                Text(error)
                    .kitType(.meta)
                    .foregroundStyle(StateColor.red.text)
            }
        }
        .onAppear {
            typed = secret.value
            if focusedOnAppear { isFocused = true }
        }
        .onChange(of: typed) { _, next in
            let seq = sync.nextSeq()
            onEdit(seq, next)
        }
        .onChange(of: secret.value) { _, remote in
            if remote != typed { typed = remote }
        }
    }
}

private struct RoomRepeatView: View {
    let repeatGroup: Centraid_Core_V1_RoomRepeat
    let callbacks: RoomCallbacks

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !repeatGroup.label.isEmpty {
                Text(repeatGroup.label)
                    .kitType(.group)
                    .foregroundStyle(Surface.body)
                    .padding(.horizontal, CentraidGeometry.pageMargin)
            }
            ForEach(Array(repeatGroup.rows.enumerated()), id: \.offset) { _, group in
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(group.fields.enumerated()), id: \.offset) { _, field in
                        RoomFieldView(field: field, callbacks: callbacks)
                    }
                    if !group.removeSelectorID.isEmpty {
                        KitLink(
                            label: KitWords.DELETE,
                            dense: true,
                            tint: StateColor.red.text,
                            identifier: group.removeSelectorID,
                            action: { callbacks.tap(group.removeSelectorID) }
                        )
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                    }
                }
                .padding(.vertical, 6)
                .overlay(alignment: .bottom) { KitHairline() }
                .modifier(OptionalIdentifier(identifier: group.selectorID))
            }
            if repeatGroup.hasAdd, !repeatGroup.add.label.isEmpty {
                KitOutlineButton(label: repeatGroup.add.label, iconKey: repeatGroup.add.icon) {
                    callbacks.tap(repeatGroup.add.selectorID)
                }
                .disabled(!repeatGroup.add.enabled)
                .accessibilityIdentifier(repeatGroup.add.selectorID)
                .padding(.horizontal, CentraidGeometry.pageMargin)
            }
        }
        .modifier(OptionalIdentifier(identifier: repeatGroup.selectorID))
    }
}

private struct RoomAutosaveRow: View {
    let autosave: Centraid_Core_V1_RoomAutosave
    let onTap: (String) -> Void

    var body: some View {
        if !autosave.label.isEmpty || !autosave.reloadLabel.isEmpty {
            HStack(spacing: 8) {
                if autosave.phase == .saving {
                    KitSpinner(label: autosave.label)
                } else if !autosave.label.isEmpty {
                    Text(autosave.label)
                        .kitType(.meta)
                        .foregroundStyle(autosave.refused ? StateColor.red.text : Surface.meta)
                }
                Spacer(minLength: 0)
                if !autosave.reloadLabel.isEmpty, !autosave.reloadSelectorID.isEmpty {
                    KitLink(label: autosave.reloadLabel, dense: true, identifier: autosave.reloadSelectorID) {
                        onTap(autosave.reloadSelectorID)
                    }
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
        }
    }
}

private struct RoomExplicitSaveRow: View {
    let explicit: Centraid_Core_V1_RoomExplicitSave
    let onTap: (String) -> Void

    var body: some View {
        VStack(spacing: 8) {
            if !explicit.saveLabel.isEmpty {
                KitInkButton(
                    label: explicit.saveLabel,
                    identifier: explicit.saveSelectorID,
                    action: { onTap(explicit.saveSelectorID) }
                )
                .disabled(!explicit.saveEnabled)
            }
            if !explicit.cancelLabel.isEmpty {
                KitLink(
                    label: explicit.cancelLabel,
                    tint: Surface.ink,
                    identifier: explicit.cancelSelectorID,
                    action: { onTap(explicit.cancelSelectorID) }
                )
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.top, 8)
    }
}
