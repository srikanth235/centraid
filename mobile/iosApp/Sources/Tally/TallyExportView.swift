import SwiftUI
import UniformTypeIdentifiers

#if canImport(CentraidShared)
import CentraidShared
#endif

/// `tally.export` — a group's ledger as a file (#1047): the group and the
/// range (each a choice sheet, the editor's grammar), the format, what the
/// file holds, and Export, the page's one ink button.
///
/// **THE VIEW DECIDES NOTHING, AND NEVER SEES THE CSV UNTIL IT IS SAVED.**
/// Which sheet is up is the machine's `sheet`; a range choice carries its
/// `export_range`, sent back as it came. Export calls the bridge's `save()`,
/// and the bridge hands the platform seam (`onSave`, installed here) the text
/// the core rendered and the name it proposed; the system exporter writes it
/// byte for byte and the bridge hears `saved`, `saveCancelled` or
/// `saveRefused`.
struct TallyExportView: View {
    let data: Data
    let send: (Data) -> Void
    let onSave: () -> Void
    let onBack: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_TallyExportState {
        (try? Centraid_Screen_V1_TallyExportState(serializedBytes: data)) ?? .init()
    }

    static func event(_ build: (inout Centraid_Screen_V1_TallyExportEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_TallyExportEvent()
        build(&event)
        return event.encoded
    }

    private func content(_ state: Centraid_Screen_V1_TallyExportState) -> ScreenContent<Centraid_Screen_V1_TallyExportData> {
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
        let chrome = state.chrome
        PushedPage(title: chrome.title, parentTitle: chrome.back, onBack: onBack) {
            EmptyView()
        } content: {
            ReadStateView(
                content: content(state),
                loadingLabel: chrome.loading,
                onRetry: { send(Self.event { $0.refreshed = .init() }) }
            ) { export in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        TallyNote(text: chrome.lede)
                        choice(chrome.groupLabel, export.groups, "tally-export-group", .group)
                        choice(chrome.rangeLabel, export.ranges, "tally-export-range", .range)
                        if !chrome.formatLabel.isEmpty {
                            FieldRow(key: chrome.formatLabel, value: chrome.formatValue)
                        }
                        if export.hasEmpty {
                            EmptyStateView(export.empty)
                        } else {
                            TallyNote(text: export.countLabel)
                            if export.canSave, !chrome.save.isEmpty {
                                KitInkButton(label: chrome.save) {
                                    if state.save != .open { onSave() }
                                }
                                .accessibilityIdentifier("tally-export-save")
                                .padding(.horizontal, CentraidGeometry.pageMargin)
                                .padding(.vertical, 8)
                            }
                            TallyNote(text: chrome.foot)
                            if !export.rows.isEmpty {
                                SectionHeader(title: chrome.rowsHeading)
                                // What the file carries, as the ledger draws it — to read, not to open.
                                ForEach(export.rows, id: \.rowKey) { row in
                                    TallyLedgerRowView(row: row) {}
                                        .allowsHitTesting(false)
                                }
                            }
                        }
                    }
                    .padding(.bottom, 16)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                ProgressStatusLine(
                    sentence: state.statusLabel,
                    refused: state.save == .refused,
                    identifier: "tally-export-status"
                )
                .background(Theme.color("bg", scheme))
            }
        }
        .sheet(isPresented: sheetBinding(state)) {
            let grouping = state.sheet == .group
            let options = grouping ? state.data.groups : state.data.ranges
            OptionSheet(title: grouping ? chrome.groupLabel : chrome.rangeLabel) {
                ForEach(options.filter(\.enabled), id: \.key) { option in
                    SheetRow(
                        label: option.label,
                        selected: option.selected,
                        identifier: "tally-export-choice-\(option.key)",
                        onTap: {
                            if grouping {
                                send(Self.event { $0.group = .with { $0.groupID = option.key } })
                            } else {
                                send(Self.event { $0.range = .with { $0.range = option.exportRange } })
                            }
                        }
                    )
                }
            }
        }
    }

    /// A choice row whose value is the picked choice's label.
    @ViewBuilder
    private func choice(
        _ key: String,
        _ choices: [Centraid_Screen_V1_TallyChoice],
        _ identifier: String,
        _ sheet: Centraid_Screen_V1_TallyExportState.Sheet
    ) -> some View {
        if !key.isEmpty, !choices.isEmpty {
            ChoiceFieldRow(
                key: key,
                value: choices.first(where: \.selected)?.label ?? "",
                identifier: identifier,
                onTap: { send(Self.event { $0.sheetOpened = .with { $0.sheet = sheet } }) }
            )
        }
    }

    private func sheetBinding(_ state: Centraid_Screen_V1_TallyExportState) -> Binding<Bool> {
        let open = state.sheet == .group || state.sheet == .range
        return Binding(
            get: { open },
            set: { shown in
                guard !shown, open else { return }
                send(Self.event { $0.sheetClosed = .init() })
            }
        )
    }
}

/// THE SAVE SEAM, AT THE ROOT (`TallyExportBridge.onSave`): the system
/// exporter over the text the core rendered, answered exactly once.
struct TallyExportRoot: View {
    @State private var exporting = false
    @State private var file = TallyCSVFile(text: "")
    @State private var name = ""
    /// The exporter answered this ask; a close with no answer is a cancel.
    @State private var answered = false

    var body: some View {
        Color.clear
            .onAppear {
                #if canImport(CentraidShared)
                TallyScreens.exportBridge.onSave = { csv, fileName in
                    DispatchQueue.main.async {
                        file = TallyCSVFile(text: csv)
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
                contentType: .commaSeparatedText,
                defaultFilename: name
            ) { result in
                answered = true
                #if canImport(CentraidShared)
                switch result {
                case .success: TallyScreens.exportBridge.saved()
                case let .failure(error):
                    if (error as NSError).code == NSUserCancelledError {
                        TallyScreens.exportBridge.saveCancelled()
                    } else {
                        TallyScreens.exportBridge.saveRefused(sentence: "")
                    }
                }
                #endif
            }
            // EXACTLY ONCE: the exporter closed without answering.
            .onChange(of: exporting) { _, up in
                guard !up else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    guard !answered else { return }
                    answered = true
                    #if canImport(CentraidShared)
                    TallyScreens.exportBridge.saveCancelled()
                    #endif
                }
            }
    }
}

/// The CSV as a document the exporter writes, UTF-8, byte for byte.
struct TallyCSVFile: FileDocument {
    static var readableContentTypes: [UTType] { [.commaSeparatedText] }
    let text: String

    init(text: String) { self.text = text }

    init(configuration: ReadConfiguration) throws {
        text = String(decoding: configuration.file.regularFileContents ?? Data(), as: UTF8.self)
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}
