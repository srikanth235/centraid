import LocalAuthentication
import SwiftUI
import UniformTypeIdentifiers

#if canImport(CentraidShared)
import CentraidShared
#endif

/// `locker.export` — every secret, in a file (#1047 T2; the handoff's
/// `locker/export`). The lede in the net register, what leaves, the format,
/// where it goes, and Write the file.
///
/// **THE VIEW DECIDES NOTHING, AND NEVER SEES THE FILE.** The confirm is the
/// machine's; the owner check is raised here once per `prompt.token` —
/// `LAContext` `.deviceOwnerAuthentication`, the lock wall's own seam and
/// outcome map — and answered with `answered`; the file goes from the bridge
/// to `LockerTransferRoot`'s save sheet and nowhere else.
struct LockerExportView: View {
    let data: Data
    let lock: Data
    let send: (Data) -> Void
    let sendLock: (Data) -> Void
    let onBack: () -> Void
    let onDeparted: () -> Void

    @Environment(\.colorScheme) private var scheme
    /// The last prompt token raised: one OS prompt per token.
    @State private var raised: UInt64 = 0

    private var state: Centraid_Screen_V1_LockerExportState {
        (try? Centraid_Screen_V1_LockerExportState(serializedBytes: data)) ?? .init()
    }

    static func event(_ build: (inout Centraid_Screen_V1_LockerExportEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_LockerExportEvent()
        build(&event)
        return event.encoded
    }

    private func content(_ state: Centraid_Screen_V1_LockerExportState) -> ScreenContent<Centraid_Screen_V1_LockerExportData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }

    var body: some View {
        let state = state
        LockerCovered(lock: lock, sendLock: sendLock, onBack: onBack) {
            PushedPage(title: state.chrome.title, parentTitle: state.chrome.backLabel, onBack: onBack) {
                EmptyView()
            } content: {
                LockerShield(lock: lock) {
                    ReadStateView(
                        content: content(state),
                        onRetry: { send(Self.event { $0.refreshed = .init() }) }
                    ) { export in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 0) { page(export) }
                                .padding(.bottom, 16)
                        }
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if state.hasStatus {
                        StatusLineView(status: state.status, identifier: "locker-export-status") {}
                            .padding(.vertical, 4)
                            .background(Theme.color("bg", scheme))
                    }
                }
            }
        }
        .onAppear { raise(state) }
        .onChange(of: state.hasPrompt ? state.prompt.token : 0) { _, _ in raise(state) }
        .sheet(isPresented: Binding(
            get: { state.hasConfirm },
            set: { open in if !open, state.hasConfirm { send(Self.event { $0.dismissed = .init() }) } }
        )) {
            LockerShield(lock: lock) {
                ConfirmSheet(
                    state.confirm,
                    onConfirm: { send(Self.event { $0.confirmed = .init() }) },
                    onDismiss: { send(Self.event { $0.dismissed = .init() }) }
                )
            }
            .modifier(SheetPresentation(detents: ConfirmSheet.detents))
        }
        .onDisappear(perform: onDeparted)
    }

    @ViewBuilder
    private func page(_ export: Centraid_Screen_V1_LockerExportData) -> some View {
        Text(export.lede)
            .centraidType("body")
            .foregroundStyle(Theme.color("net", scheme))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 12)
            .accessibilityIdentifier("locker-export-lede")
        FieldRow(key: export.whatLabel, value: export.whatValue, note: export.leavesOut)
        VStack(alignment: .leading, spacing: 2) {
            Text(export.formatLabel)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
                .padding(.horizontal, CentraidGeometry.pageMargin)
            LockerChoicePills(choices: export.formats, identifier: "locker-export-format") { key in
                send(Self.event { $0.format = .with { $0.key = key } })
            }
            LockerNote(text: export.formatNote)
        }
        .padding(.top, 8)
        FieldRow(key: export.whereLabel, value: export.whereValue, note: export.whereNote)
        if !export.commitLabel.isEmpty {
            KitInkButton(label: export.commitLabel) {
                send(Self.event { $0.commit = .init() })
            }
            .accessibilityIdentifier("locker-export-commit")
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.top, 12)
        }
        LockerNote(text: export.commitNote)
    }

    /// THE OWNER CHECK, AFRESH: the lock wall's seam, once per token.
    private func raise(_ state: Centraid_Screen_V1_LockerExportState) {
        guard state.hasPrompt, state.prompt.token != 0, state.prompt.token > raised else { return }
        let token = state.prompt.token
        raised = token
        LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: state.prompt.reason) { ok, error in
            let outcome = ok ? Centraid_Screen_V1_LockerLockEvent.PromptAnswered.Outcome.succeeded : LockerLockSeam.outcome(error)
            DispatchQueue.main.async {
                send(Self.event { $0.answered = .with { $0.token = token; $0.outcome = outcome } })
            }
        }
    }
}

/// `locker.import` — a password-manager file, reviewed and sealed in (#1047
/// T2; the handoff's `locker/import`). Choose is an intent: the view opens
/// the system file importer, reads the chosen file's bytes from the
/// importer's own URL — never copied into this app's storage — and hands
/// them to the bridge. Every word, verdict and verb is the machine's.
struct LockerImportView: View {
    let data: Data
    let lock: Data
    let send: (Data) -> Void
    let sendLock: (Data) -> Void
    let onPicked: (String, Data) -> Void
    let onBack: () -> Void
    let onDeparted: () -> Void

    @Environment(\.colorScheme) private var scheme
    @State private var importing = false

    private var state: Centraid_Screen_V1_LockerImportState {
        (try? Centraid_Screen_V1_LockerImportState(serializedBytes: data)) ?? .init()
    }

    static func event(_ build: (inout Centraid_Screen_V1_LockerImportEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_LockerImportEvent()
        build(&event)
        return event.encoded
    }

    private func content(_ state: Centraid_Screen_V1_LockerImportState) -> ScreenContent<Centraid_Screen_V1_LockerImportData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }

    var body: some View {
        let state = state
        LockerCovered(lock: lock, sendLock: sendLock, onBack: onBack) {
            PushedPage(title: state.chrome.title, parentTitle: state.chrome.backLabel, onBack: onBack) {
                EmptyView()
            } content: {
                LockerShield(lock: lock) {
                    ReadStateView(
                        content: content(state),
                        onRetry: { send(Self.event { $0.refreshed = .init() }) }
                    ) { plan in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 0) { page(plan) }
                                .padding(.bottom, 16)
                        }
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if state.hasStatus {
                        StatusLineView(status: state.status, identifier: "locker-import-status") {}
                            .padding(.vertical, 4)
                            .background(Theme.color("bg", scheme))
                    }
                }
            }
        }
        .fileImporter(
            isPresented: $importing,
            allowedContentTypes: [.commaSeparatedText, .json, .plainText],
            allowsMultipleSelection: false
        ) { result in
            guard case let .success(urls) = result, let url = urls.first else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            // READ IN PLACE: the file's bytes, from the importer's own URL.
            if let bytes = try? Data(contentsOf: url) {
                onPicked(url.lastPathComponent, bytes)
            }
        }
        .onDisappear(perform: onDeparted)
    }

    @ViewBuilder
    private func page(_ plan: Centraid_Screen_V1_LockerImportData) -> some View {
        LockerNote(text: plan.lede)
        FieldRow(key: plan.fileLabel, value: plan.fileValue, note: plan.fileNote)
        if !plan.chooseLabel.isEmpty {
            KitOutlineButton(label: plan.chooseLabel) {
                send(Self.event { $0.choose = .init() })
                importing = true
            }
            .accessibilityIdentifier("locker-import-choose")
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 8)
        }
        if !plan.verdicts.isEmpty {
            SectionHeader(title: plan.verdictsLabel)
            ForEach(Array(plan.verdicts.enumerated()), id: \.offset) { _, verdict in
                FieldRow(key: verdict.label, value: verdict.detail)
            }
        }
        if plan.hasEmpty {
            EmptyStateView(plan.empty)
        }
        if !plan.rowsLabel.isEmpty {
            SectionHeader(title: plan.rowsLabel)
            LockerNote(text: plan.counts)
            ForEach(plan.rows, id: \.key) { row in
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.title)
                            .centraidType("body")
                            .foregroundStyle(Theme.color("text", scheme))
                            .lineLimit(1)
                        Text(row.meta)
                            .centraidType("annotLabel")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .lineLimit(2)
                    }
                    Spacer(minLength: 8)
                    StatusChipView(row.chip)
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
                .overlay(alignment: .bottom) { KitHairline() }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(row.accessibilityLabel)
                .accessibilityIdentifier("locker-import-\(row.key)")
            }
        }
        if !plan.publishLabel.isEmpty {
            KitInkButton(label: plan.publishLabel) {
                send(Self.event { $0.publish = .init() })
            }
            .accessibilityIdentifier("locker-import-publish")
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.top, 12)
            LockerNote(text: plan.publishNote)
        }
        if !plan.discardLabel.isEmpty {
            KitOutlineButton(label: plan.discardLabel) {
                send(Self.event { $0.discard = .init() })
            }
            .accessibilityIdentifier("locker-import-discard")
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 8)
        }
    }
}

/// THE EXPORT'S SAVE SEAM, AT THE ROOT (`LockerExportBridge.onSave`): the
/// system exporter over the bytes the core rendered, written by the system
/// where the member chooses, answered exactly once. No temporary file and no
/// copy in this app's storage: the document hands its bytes to the exporter.
struct LockerTransferRoot: View {
    @State private var exporting = false
    @State private var file = LockerExportFile(bytes: Data(), type: .commaSeparatedText)
    @State private var name = ""
    @State private var answered = false

    var body: some View {
        Color.clear
            .onAppear {
                #if canImport(CentraidShared)
                LockerScreens.exportBridge.onSave = { bytes, fileName, mediaType in
                    let data = bytes.data
                    DispatchQueue.main.async {
                        file = LockerExportFile(bytes: data, type: mediaType == "application/json" ? .json : .commaSeparatedText)
                        name = fileName
                        answered = false
                        exporting = true
                    }
                }
                #endif
            }
            .fileExporter(
                isPresented: $exporting,
                document: file,
                contentType: file.type,
                defaultFilename: name
            ) { result in
                answered = true
                #if canImport(CentraidShared)
                switch result {
                case .success: LockerScreens.exportBridge.saved()
                case let .failure(error):
                    if (error as NSError).code == NSUserCancelledError {
                        LockerScreens.exportBridge.saveCancelled()
                    } else {
                        LockerScreens.exportBridge.saveRefused(sentence: "")
                    }
                }
                #endif
                // THE BYTES LEAVE THIS VIEW'S STATE with the sheet.
                file = LockerExportFile(bytes: Data(), type: .commaSeparatedText)
            }
            // EXACTLY ONCE: the exporter closed without answering.
            .onChange(of: exporting) { _, up in
                guard !up else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    file = LockerExportFile(bytes: Data(), type: .commaSeparatedText)
                    guard !answered else { return }
                    answered = true
                    #if canImport(CentraidShared)
                    LockerScreens.exportBridge.saveCancelled()
                    #endif
                }
            }
    }
}

/// The export as a document the exporter writes, byte for byte.
struct LockerExportFile: FileDocument {
    static var readableContentTypes: [UTType] { [.commaSeparatedText, .json] }
    let bytes: Data
    let type: UTType

    init(bytes: Data, type: UTType) {
        self.bytes = bytes
        self.type = type
    }

    init(configuration: ReadConfiguration) throws {
        bytes = configuration.file.regularFileContents ?? Data()
        type = configuration.contentType
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: bytes)
    }
}
