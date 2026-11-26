import SwiftUI

struct RoomTextSync: Equatable, Sendable {
    private(set) var lastSentSeq: UInt64 = 0

    mutating func nextSeq() -> UInt64 {
        lastSentSeq &+= 1
        return lastSentSeq
    }

    func shouldAdopt(remoteValue: String, remoteRev: UInt64, localText: String) -> Bool {
        remoteValue != localText && remoteRev >= lastSentSeq
    }
}

struct RoomTextField: View {
    let selectorID: String
    let label: String
    let hint: String
    let error: String
    let focusedOnAppear: Bool
    let text: Centraid_Core_V1_RoomText
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
            if !text.chips.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(Array(text.chips.enumerated()), id: \.offset) { _, chip in
                            RoomChipView(chip: chip, onTap: onTap)
                        }
                    }
                }
            }
            inputControl
                .focused($isFocused)
                .kitType(.row)
                .foregroundStyle(Surface.ink)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
                .background(Surface.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(
                            error.isEmpty ? Surface.border : StateColor.red.text,
                            lineWidth: CentraidGeometry.hairline
                        )
                )
                .accessibilityIdentifier(selectorID)
            if !error.isEmpty {
                Text(error)
                    .kitType(.meta)
                    .foregroundStyle(StateColor.red.text)
            }
        }
        .onAppear {
            typed = text.value
            if focusedOnAppear { isFocused = true }
        }
        .onChange(of: typed) { _, next in
            let limited = applyLimit(next)
            if limited != next {
                typed = limited
                return
            }
            let seq = sync.nextSeq()
            onEdit(seq, limited)
        }
        .onChange(of: text.rev) { _, rev in
            if sync.shouldAdopt(remoteValue: text.value, remoteRev: rev, localText: typed) {
                typed = text.value
            }
        }
        .onChange(of: text.value) { _, remote in
            if sync.shouldAdopt(remoteValue: remote, remoteRev: text.rev, localText: typed) {
                typed = remote
            }
        }
        .onChange(of: focusedOnAppear) { _, now in
            if now { isFocused = true }
        }
    }

    @ViewBuilder
    private var inputControl: some View {
        switch text.kind {
        case .paragraph:
            TextField(hint, text: $typed, axis: .vertical)
                .lineLimit(3...10)
        case .email:
            TextField(hint, text: $typed)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
        case .phone:
            TextField(hint, text: $typed)
                .keyboardType(.phonePad)
        case .url:
            TextField(hint, text: $typed)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
        case .number:
            TextField(hint, text: $typed)
                .keyboardType(.decimalPad)
        case .line, .unspecified, .UNRECOGNIZED:
            TextField(hint, text: $typed)
        }
    }

    private func applyLimit(_ value: String) -> String {
        guard text.maxChars > 0, value.count > Int(text.maxChars) else { return value }
        return String(value.prefix(Int(text.maxChars)))
    }
}

struct RoomMoneyField: View {
    let selectorID: String
    let label: String
    let error: String
    let focusedOnAppear: Bool
    let money: Centraid_Core_V1_RoomMoney
    let onMinor: (UInt64, Int64) -> Void

    @State private var digits = ""
    @State private var sync = RoomTextSync()
    @FocusState private var isFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !label.isEmpty {
                Text(label)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
            }
            ZStack(alignment: .leading) {
                Text(money.display)
                    .kitType(.section)
                    .monospacedDigit()
                    .foregroundStyle(Surface.ink)
                TextField("", text: $digits)
                    .keyboardType(.numberPad)
                    .focused($isFocused)
                    .opacity(0.02)
                    .accessibilityLabel(label.isEmpty ? money.currency : label)
                    .accessibilityValue(money.display)
                    .accessibilityIdentifier(selectorID)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
            .background(Surface.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(
                        error.isEmpty ? Surface.border : StateColor.red.text,
                        lineWidth: CentraidGeometry.hairline
                    )
            )
            if !error.isEmpty {
                Text(error)
                    .kitType(.meta)
                    .foregroundStyle(StateColor.red.text)
            }
        }
        .onAppear {
            digits = money.minor == 0 ? "" : String(abs(money.minor))
            if focusedOnAppear { isFocused = true }
        }
        .onChange(of: digits) { _, next in
            let cleaned = next.filter(\.isNumber)
            if cleaned != next {
                digits = cleaned
                return
            }
            let signed: Int64 = (money.minor < 0 ? -1 : 1) * (Int64(cleaned) ?? 0)
            let seq = sync.nextSeq()
            onMinor(seq, signed)
        }
    }
}
