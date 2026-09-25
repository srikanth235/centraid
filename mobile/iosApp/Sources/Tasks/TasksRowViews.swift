import SwiftUI

// TASKS' ONE ROW SHAPE, ITS STATUS LINE AND ITS QUICK-ADD BAR (#1029 port).
//
// Every list in Tasks draws `TasksRowView` and nothing else, so a task looks
// the same on Today, in a project, in the Logbook and under its parent. Every
// word is the row's (`TasksRow`, folded in `TasksRows.kt`); this file maps
// fields to geometry and taps to the caller's closures.

/// One task: the box, the title with its due words and priority, the clamped
/// meta line, the project dot, the pending rule — and its family under it.
struct TasksRowView: View {
    let row: Centraid_Screen_V1_TasksRow
    let onCheck: (String) -> Void
    let onPick: (String) -> Void
    /// The row's visible filing verb ("File"); a row that can file draws it.
    var fileVerb: String = ""
    var onFile: ((String) -> Void)? = nil

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(spacing: 0) {
            line
            ForEach(row.children, id: \.taskID) { child in
                TasksRowView(row: child, onCheck: onCheck, onPick: onPick)
                    .padding(.leading, 28)
            }
        }
    }

    private var settled: Bool { row.check == .done || row.check == .wontDo }

    private var line: some View {
        HStack(alignment: .top, spacing: 10) {
            TasksCheckBox(check: row.check, label: row.checkLabel, enabled: row.canCheck) { onCheck(row.taskID) }
            Button { onPick(row.taskID) } label: {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        if !row.projectHueKey.isEmpty {
                            Circle()
                                .fill(Theme.color(AgendaHue.role(row.projectHueKey), scheme))
                                .frame(width: 6, height: 6)
                        }
                        Text(row.title)
                            .centraidType(row.subtask ? "small" : "body")
                            .foregroundStyle(Theme.color(settled ? "textFaint" : "text", scheme))
                            .strikethrough(row.check == .done, color: Theme.color("textFaint", scheme))
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if !row.priorityLabel.isEmpty {
                            Text(row.priorityLabel)
                                .centraidType("annotLabel")
                                .foregroundStyle(Theme.color("textSoft", scheme))
                        }
                        if !row.dueLabel.isEmpty {
                            Text(row.dueLabel)
                                .centraidType("annotLabel")
                                .monospacedDigit()
                                .foregroundStyle(Theme.color(row.overdue ? "warning" : "textSoft", scheme))
                        }
                    }
                    if !row.meta.isEmpty {
                        Text(row.meta)
                            .centraidType("annotLabel")
                            .foregroundStyle(Theme.color("textFaint", scheme))
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(row.accessibilityLabel.isEmpty ? row.title : row.accessibilityLabel)
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("tasks-row-\(row.taskID)")
            if row.canFile, let onFile, !fileVerb.isEmpty {
                Button { onFile(row.taskID) } label: {
                    Text(fileVerb)
                        .centraidType("annotLabelOn")
                        .foregroundStyle(Theme.color("link", scheme))
                        .frame(minHeight: CentraidGeometry.targetMinFine)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("tasks-row-file-\(row.taskID)")
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
        .overlay(alignment: .leading) {
            // A WRITE THIS PHONE HOLDS: the 2pt rule at the inline start.
            if row.pending {
                Rectangle()
                    .fill(Theme.color("seam", scheme))
                    .frame(width: 2)
                    .padding(.vertical, 8)
            }
        }
        .overlay(alignment: .bottom) { KitHairline() }
    }
}

/// The box: open, done (a check), won't do (a dash) or started (half). The
/// label is the row's own sentence ("Mark Buy milk done").
struct TasksCheckBox: View {
    let check: Centraid_Screen_V1_TasksCheck
    let label: String
    var enabled: Bool = true
    let action: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: action) {
            ZStack {
                RoundedRectangle(cornerRadius: 5)
                    .strokeBorder(Theme.color(check == .open || check == .unspecified ? "lineStrong" : "textSoft", scheme), lineWidth: 1.5)
                switch check {
                case .done:
                    CentraidIconView(iconKey: "Check", tint: Theme.color("textSoft", scheme), size: 14)
                case .wontDo:
                    Rectangle().fill(Theme.color("textSoft", scheme)).frame(width: 10, height: 1.5)
                case .inProcess:
                    Rectangle().fill(Theme.color("textSoft", scheme)).frame(width: 10, height: 10)
                        .mask(alignment: .leading) { Rectangle().frame(width: 5) }
                default:
                    EmptyView()
                }
            }
            .frame(width: 20, height: 20)
            .frame(width: CentraidGeometry.targetMinFine, height: CentraidGeometry.targetMinFine)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
        .accessibilityLabel(label)
    }
}

/// A group's head (month heading over it when the list turns a month) and
/// its rows.
struct TasksGroupView: View {
    let group: Centraid_Screen_V1_TasksRowGroup
    let onVerb: (String) -> Void
    let onCheck: (String) -> Void
    let onPick: (String) -> Void
    var fileVerb: String = ""
    var onFile: ((String) -> Void)? = nil

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if group.hasMonthHeading {
                Text(group.monthHeading)
                    .centraidType("title")
                    .foregroundStyle(Theme.color("text", scheme))
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.top, 20)
                    .accessibilityAddTraits(.isHeader)
            }
            SectionHeader(
                title: group.title,
                count: UInt32(group.meta),
                verb: group.verbLabel,
                onVerb: group.verbKey.isEmpty ? nil : { onVerb(group.verbKey) }
            )
            ForEach(group.rows, id: \.taskID) { row in
                TasksRowView(row: row, onCheck: onCheck, onPick: onPick, fileVerb: fileVerb, onFile: onFile)
            }
        }
    }
}

/// THE QUICK-ADD BAR: a bare title, where it lands, and Add.
struct TasksQuickAddBar: View {
    let quickAdd: Centraid_Screen_V1_TasksQuickAdd
    let placeholder: String
    let verb: String
    let onChange: (String) -> Void
    let onSubmit: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if quickAdd.shown {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    CentraidIconView(iconKey: "Plus", tint: Theme.color("textFaint", scheme), size: 16)
                    // THE MACHINE SAYS WHEN THE BAR TAKES THE KEYBOARD (Notes'
                    // "Send to Tasks" lands with words in it).
                    MachineTextField(
                        placeholder: placeholder,
                        value: quickAdd.title,
                        focusOnAppear: quickAdd.focused,
                        onEdit: onChange,
                        onSubmit: { if quickAdd.canSubmit { onSubmit() } }
                    )
                    .centraidType("body")
                    .submitLabel(.done)
                    .accessibilityLabel(placeholder)
                    .accessibilityIdentifier("tasks-quick-add-field")
                    Button(action: onSubmit) {
                        Text(verb)
                            .centraidType("smallStrong")
                            .foregroundStyle(Theme.color(quickAdd.canSubmit ? "link" : "textFaint", scheme))
                            .frame(minHeight: CentraidGeometry.targetMinCoarse)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!quickAdd.canSubmit)
                    .accessibilityIdentifier("tasks-quick-add-verb")
                }
                .padding(.horizontal, 12)
                .background(Theme.color("bgSunken", scheme))
                .clipShape(RoundedRectangle(cornerRadius: Theme.radius("md", scheme)))
                if !quickAdd.landsLabel.isEmpty {
                    Text(quickAdd.landsLabel)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                        .padding(.leading, 12)
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 6)
        }
    }
}

/// A list's head line: "7 tasks", and the window's words when the list is a
/// window and not everything.
struct TasksCountLine: View {
    let count: String
    let window: String

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if !count.isEmpty || !window.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                if !count.isEmpty {
                    Text(count).centraidType("annotLabel").foregroundStyle(Theme.color("textSoft", scheme))
                }
                if !window.isEmpty {
                    Text(window).centraidType("annotLabel").foregroundStyle(Theme.color("textFaint", scheme))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.top, 4)
        }
    }
}

extension Centraid_Screen_V1_TasksHomeState {
    var readContent: ScreenContent<Centraid_Screen_V1_TasksHomeData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}

extension Centraid_Screen_V1_TasksListState {
    var readContent: ScreenContent<Centraid_Screen_V1_TasksListData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}

extension Centraid_Screen_V1_TasksProjectState {
    var readContent: ScreenContent<Centraid_Screen_V1_TasksProjectData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}

extension Centraid_Screen_V1_TasksCatchUpState {
    var readContent: ScreenContent<Centraid_Screen_V1_TasksCatchUpData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}
