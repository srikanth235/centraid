import SwiftUI

// TASKS' ONE ROW SHAPE, ITS STATUS LINE AND ITS QUICK-ADD BAR (#1029 port).
//
// Every list in Tasks draws `TasksRowView` and nothing else, so a task looks
// the same on Today, in a project, in the Logbook and under its parent. Every
// word is the row's (`TasksRow`, folded in `TasksRows.kt`); this file maps
// fields to geometry and taps to the caller's closures.

/// One task: the circle (a subtask's box), the title with its priority, the
/// due words and clamped meta under it, the project dot, the pending rule —
/// and its family under it.
struct TasksRowView: View {
    let row: Centraid_Screen_V1_TasksRow
    let onCheck: (String) -> Void
    let onPick: (String) -> Void
    /// The row's filing verb ("Move to project"), offered on a long press by a
    /// row that can file.
    var fileVerb: String = ""
    var onFile: ((String) -> Void)? = nil
    /// The row sits inside a section that already holds the page margin (a day
    /// of Agenda's Day or Schedule, #1128): it keeps the event rows' 10pt lead
    /// and draws neither a margin nor the hairline, so a task lines up with the
    /// events around it.
    var embedded: Bool = false
    /// The ids a flow taps: `<prefix>-<task id>` on the row, `<prefix>-check-<task id>` on its box.
    var identifierPrefix: String = "tasks-row"

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(spacing: 0) {
            line
            ForEach(row.children, id: \.taskID) { child in
                TasksRowView(row: child, onCheck: onCheck, onPick: onPick, embedded: embedded, identifierPrefix: identifierPrefix)
                    .padding(.leading, 28)
            }
        }
    }

    private var settled: Bool { row.check == .done || row.check == .wontDo }

    /// The box's 44 target overhangs its 20pt mark by this much on every
    /// side, so the mark sits on the page margin and on the title's first
    /// line rather than mid-row; the gap to the title is the overhang.
    private static let boxOverhang: CGFloat = (CentraidGeometry.targetMinCoarse - 20) / 2

    private var line: some View {
        HStack(alignment: .top, spacing: Self.boxOverhang) {
            // A TASK IS A CIRCLE, a subtask a box: the shape the starter row
            // ("Tap the circle to finish me") and every task list teach.
            KitCheckBox(
                state: row.check.kitState,
                label: row.checkLabel,
                identifier: "\(identifierPrefix)-check-\(row.taskID)",
                round: !row.subtask
            ) { onCheck(row.taskID) }
                .disabled(!row.canCheck)
                .padding(-Self.boxOverhang)
                .padding(.top, 1)
            Button { onPick(row.taskID) } label: {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        if !row.projectHueKey.isEmpty {
                            Circle()
                                .fill(Theme.color(KitHue.role(row.projectHueKey) ?? "cSlate", scheme))
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
                    }
                    // THE DUE WORDS LEAD THE SECOND LINE, so a trailing column
                    // never squeezes the title into a wrap.
                    if !row.dueLabel.isEmpty || !row.meta.isEmpty {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            if !row.dueLabel.isEmpty {
                                Text(row.dueLabel)
                                    .centraidType("annotLabel")
                                    .monospacedDigit()
                                    .foregroundStyle(Theme.color(row.overdue ? "warning" : "textSoft", scheme))
                            }
                            if !row.meta.isEmpty {
                                Text(row.meta)
                                    .centraidType("annotLabel")
                                    .foregroundStyle(Theme.color("textFaint", scheme))
                                    .lineLimit(1)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(KitRowPress())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(row.accessibilityLabel.isEmpty ? row.title : row.accessibilityLabel)
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("\(identifierPrefix)-\(row.taskID)")
            .contextMenu {
                if row.canFile, let onFile, !fileVerb.isEmpty {
                    Button { onFile(row.taskID) } label: {
                        Label(fileVerb, systemImage: "folder")
                    }
                    .accessibilityIdentifier("\(identifierPrefix)-file-\(row.taskID)")
                }
            }
            .accessibilityActions {
                if row.canFile, let onFile, !fileVerb.isEmpty {
                    Button(fileVerb) { onFile(row.taskID) }
                }
            }
        }
        .padding(.leading, embedded ? 10 : CentraidGeometry.pageMargin)
        .padding(.trailing, embedded ? 0 : CentraidGeometry.pageMargin)
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
        // THE RULE STARTS WHERE THE WORDS DO, as the phone's own lists draw it.
        .overlay(alignment: .bottom) {
            if !embedded { KitHairline(inset: CentraidGeometry.pageMargin + 20 + Self.boxOverhang) }
        }
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
    var identifierPrefix: String = "tasks-row"

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
                TasksRowView(row: row, onCheck: onCheck, onPick: onPick, fileVerb: fileVerb, onFile: onFile, identifierPrefix: identifierPrefix)
            }
        }
    }
}

/// THE QUICK-ADD BAR: a bare title whose placeholder says where it lands, and
/// Add once there are words. Drawn while the machine holds it `drawn` — on
/// Agenda's To-do, only after the header's Plus.
struct TasksQuickAddBar: View {
    let quickAdd: Centraid_Screen_V1_TasksQuickAdd
    let placeholder: String
    let verb: String
    let onChange: (String) -> Void
    let onSubmit: () -> Void
    /// The field took or gave up the keyboard. The screen that hosts the bar
    /// uses it to put its band away while the keyboard is up, so the bar sits
    /// on the keyboard and not under it.
    var onFocusChange: ((Bool) -> Void)? = nil
    /// The field's id and its Add verb's (`agenda-quick-add` on To-do).
    var fieldIdentifier: String = "tasks-quick-add-field"
    var verbIdentifier: String = "tasks-quick-add-verb"

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if quickAdd.shown && quickAdd.drawn {
            let prompt = quickAdd.landsLabel.isEmpty ? placeholder : quickAdd.landsLabel
            HStack(spacing: 8) {
                // THE MACHINE SAYS WHEN THE BAR TAKES THE KEYBOARD: the Plus
                // opened it, or Notes' "Send to Tasks" landed with words in it.
                MachineTextField(
                    placeholder: prompt,
                    value: quickAdd.title,
                    focusOnAppear: quickAdd.focused,
                    onEdit: onChange,
                    onSubmit: { if quickAdd.canSubmit { onSubmit() } },
                    onFocusChange: onFocusChange
                )
                .centraidType("body")
                .submitLabel(.done)
                .accessibilityLabel(prompt)
                .accessibilityIdentifier(fieldIdentifier)
                // ADD ONLY ONCE THERE ARE WORDS: a greyed verb read as a second
                // placeholder.
                if quickAdd.canSubmit {
                    KitLink(label: verb, identifier: verbIdentifier, action: onSubmit)
                }
            }
            .frame(minHeight: CentraidGeometry.targetMinCoarse)
            .padding(.horizontal, 12)
            .background(Theme.color("bgSunken", scheme))
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius("md", scheme)))
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

extension Centraid_Screen_V1_TasksCheck {
    /// The box's face: open, done (a check), won't do (a dash) or started (half).
    var kitState: KitCheckState {
        switch self {
        case .done: .on
        case .wontDo: .mixed
        case .inProcess: .partial
        default: .off
        }
    }
}
