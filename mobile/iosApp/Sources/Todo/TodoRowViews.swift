import SwiftUI

// THE TO-DO ROW SHAPE AND ITS QUICK-ADD BAR (#1135).
//
// Every list in Agenda's to-do draws `TodoRowView` and nothing else, so a task
// looks the same on a day, in a project, in the Logbook and under its parent.
// Every word is the row's (`TodoRow`, made in Rust); this file maps fields to
// geometry and taps to the caller's closures. A tap on a row hands its `route`
// to the caller, who pushes it.

/// One task: the circle (a subtask's box), the title with its priority, the
/// due words and clamped meta under it, the project dot, the pending rule —
/// and its family under it.
struct TodoRowView: View {
    @Environment(\.isLargestText) private var largestText
    let row: Centraid_Core_V1_TodoRow
    let onCheck: (String) -> Void
    let onPick: (Centraid_Core_V1_Route) -> Void
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
    /// THE LONG PRESS (#1173): Details, Flag and Delete, in the chrome's words.
    var chrome: Centraid_Core_V1_TodoChrome? = nil
    var onFlag: ((String, Bool) -> Void)? = nil
    var onDelete: ((String) -> Void)? = nil
    /// DRAG TO REORDER: this row was dropped on another; (moved id, the id it lands before).
    var onMove: ((String, String) -> Void)? = nil
    /// The non-drag reorder, for a screen reader and the long press: nil at the group's edge.
    var onMoveUp: (() -> Void)? = nil
    var onMoveDown: (() -> Void)? = nil
    /// A DAY'S DATE COLUMN, when the row is a row of Agenda's Day or Schedule `List`: the row keeps
    /// `gutter` points free on its leading side, and the day's first row draws its date there.
    var gutter: CGFloat = 0
    var gutterContent: AnyView? = nil

    @Environment(\.colorScheme) private var scheme

    /// A GROUP, NOT A STACK: in a `List` the task and each subtask are rows of their own, so a swipe
    /// lands on the one the finger is on; in a stack they sit one under the other as before.
    var body: some View {
        Group {
            line
            ForEach(row.children, id: \.taskID) { child in
                TodoRowView(
                    row: child, onCheck: onCheck, onPick: onPick, embedded: embedded, identifierPrefix: identifierPrefix,
                    chrome: chrome, onFlag: onFlag, onDelete: onDelete, gutter: gutter
                )
                .padding(.leading, 28)
            }
        }
    }

    /// THE SWIPE AND THE LONG PRESS (#1173, the Swipe board): Details, Flag and Delete in the chrome's
    /// words, and the row's own extras (reorder, filing) in the menu only. One list of actions, so the
    /// two are never out of step.
    private var rowActions: [KitRowAction] {
        guard let chrome else { return [] }
        var actions = [
            KitRowAction(id: "details", label: chrome.detailsVerb, iconKey: "FileText") { onPick(row.route) },
        ]
        // CALENDAR'S REMINDER on a day is read-only: it opens in Reminders and nothing else.
        if row.readOnly { return actions }
        if let onFlag {
            actions.append(
                KitRowAction(id: "flag", label: row.flagged ? chrome.unflagVerb : chrome.flagVerb, iconKey: "Flag", tone: .amber) {
                    onFlag(row.taskID, !row.flagged)
                }
            )
        }
        if let onMoveUp {
            actions.append(KitRowAction(id: "move-up", label: chrome.moveUpVerb, iconKey: "ChevronUp", menuOnly: true, action: onMoveUp))
        }
        if let onMoveDown {
            actions.append(KitRowAction(id: "move-down", label: chrome.moveDownVerb, iconKey: "ChevronDown", menuOnly: true, action: onMoveDown))
        }
        if row.canFile, let onFile, !fileVerb.isEmpty {
            actions.append(KitRowAction(id: "file", label: fileVerb, iconKey: "Folder", menuOnly: true) { onFile(row.taskID) })
        }
        if let onDelete {
            actions.append(KitRowAction(id: "delete", label: chrome.deleteVerb, iconKey: "Trash", tone: .red) { onDelete(row.taskID) })
        }
        return actions
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
            ) { if row.readOnly { onPick(row.route) } else { onCheck(row.taskID) } }
                .padding(-Self.boxOverhang)
                .padding(.top, 1)
            Button { onPick(row.route) } label: {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        // THE LIST'S COLOUR (#1173): one of the eight, a dot before the title.
                        if let color = AgendaPalette.list(row.listColorKey) {
                            Circle().fill(color).frame(width: 6, height: 6)
                        } else if !row.projectHueKey.isEmpty {
                            Circle()
                                .fill(Theme.color(KitHue.role(row.projectHueKey) ?? "cSlate", scheme))
                                .frame(width: 6, height: 6)
                        }
                        Text(row.title)
                            .centraidType(row.subtask ? "small" : "body")
                            .foregroundStyle(Theme.color(settled ? "textFaint" : "text", scheme))
                            .strikethrough(row.check == .done, color: Theme.color("textFaint", scheme))
                            .lineLimit(largestText ? nil : 2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if !row.priorityLabel.isEmpty {
                            Text(row.priorityLabel)
                                .centraidType("annotLabel")
                                .foregroundStyle(Theme.color("textSoft", scheme))
                        }
                        if row.flagged {
                            CentraidIconView(iconKey: "Flag", tint: AgendaPalette.token("stateAmberText"), size: 14)
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
                                    .foregroundStyle(row.overdue ? AgendaPalette.token("stateRedText") : Theme.color("textSoft", scheme))
                            }
                            if !row.meta.isEmpty {
                                Text(row.meta)
                                    .centraidType("annotLabel")
                                    .foregroundStyle(Theme.color("textFaint", scheme))
                                    .lineLimit(largestText ? nil : 1)
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
            .accessibilityActions {
                if let chrome {
                    Button(chrome.detailsVerb) { onPick(row.route) }
                    if let onFlag { Button(row.flagged ? chrome.unflagVerb : chrome.flagVerb) { onFlag(row.taskID, !row.flagged) } }
                    if let onMoveUp { Button(chrome.moveUpVerb, action: onMoveUp) }
                    if let onMoveDown { Button(chrome.moveDownVerb, action: onMoveDown) }
                    if let onDelete { Button(chrome.deleteVerb) { onDelete(row.taskID) } }
                }
                if row.canFile, let onFile, !fileVerb.isEmpty {
                    Button(fileVerb) { onFile(row.taskID) }
                }
            }
        }
        .padding(.leading, embedded ? 10 : CentraidGeometry.pageMargin)
        .padding(.trailing, embedded ? 0 : CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .modifier(TodoReorder(taskID: row.taskID, enabled: onMove != nil && !row.subtask, onMove: onMove))
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
        // THE RULE STARTS WHERE THE WORDS DO, as the phone's own lists draw it.
        .overlay(alignment: .bottom) {
            if !embedded { KitHairline(inset: CentraidGeometry.pageMargin + 20 + Self.boxOverhang) }
        }
        .padding(.leading, gutter)
        .overlay(alignment: .topLeading) {
            if let gutterContent { gutterContent.padding(.top, 8) }
        }
        .kitRowActions(rowActions)
    }
}

extension View {
    /// A row of a task `List`: edge to edge, no system separator or fill, since the row draws its own
    /// rule. Outside a `List` it does nothing.
    func todoPlainRow() -> some View {
        listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }
}

/// Drag a row onto another to put it before it (#1173). Rust finds the
/// positions; the row only names the two ids.
private struct TodoReorder: ViewModifier {
    let taskID: String
    let enabled: Bool
    let onMove: ((String, String) -> Void)?

    func body(content: Content) -> some View {
        if enabled, let onMove {
            content
                .draggable(taskID)
                .dropDestination(for: String.self) { items, _ in
                    guard let moved = items.first, moved != taskID else { return false }
                    onMove(moved, taskID)
                    return true
                }
        } else {
            content
        }
    }
}

/// A group's head (month heading over it when the list turns a month) and
/// its rows.
struct TodoGroupView: View {
    let group: Centraid_Core_V1_TodoRowGroup
    let onVerb: (String) -> Void
    let onCheck: (String) -> Void
    let onPick: (Centraid_Core_V1_Route) -> Void
    var fileVerb: String = ""
    var onFile: ((String) -> Void)? = nil
    var identifierPrefix: String = "tasks-row"
    var chrome: Centraid_Core_V1_TodoChrome? = nil
    var onFlag: ((String, Bool) -> Void)? = nil
    var onDelete: ((String) -> Void)? = nil
    var onMove: ((String, String) -> Void)? = nil
    /// Drawn as the rows of a `List` (the head and each task its own row, so a swipe lands on one task)
    /// and not as one stack.
    var inList: Bool = false

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if inList {
            Group { rows }.todoPlainRow()
        } else {
            VStack(alignment: .leading, spacing: 0) { rows }
        }
    }

    @ViewBuilder
    private var rows: some View {
        Group {
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
            ForEach(Array(group.rows.enumerated()), id: \.element.taskID) { index, row in
                TodoRowView(
                    row: row, onCheck: onCheck, onPick: onPick, fileVerb: fileVerb, onFile: onFile,
                    identifierPrefix: identifierPrefix, chrome: chrome, onFlag: onFlag, onDelete: onDelete, onMove: onMove,
                    // Up: before the row above. Down: before the row after next (none: the end).
                    onMoveUp: onMove.flatMap { move in index > 0 ? { move(row.taskID, group.rows[index - 1].taskID) } : nil },
                    onMoveDown: onMove.flatMap { move in
                        index < group.rows.count - 1
                            ? { move(row.taskID, index + 2 < group.rows.count ? group.rows[index + 2].taskID : "") }
                            : nil
                    }
                )
            }
        }
    }
}

/// THE QUICK-ADD BAR: a bare title whose placeholder says where it lands, and
/// Add once there are words. Drawn while Rust holds it `drawn` — on
/// Agenda's To-do, only after the header's Plus.
struct TodoQuickAddBar: View {
    let quickAdd: Centraid_Core_V1_TodoQuickAdd
    let placeholder: String
    let verb: String
    let onChange: (String) -> Void
    let onSubmit: () -> Void
    /// The date chip's ×: keep the typed words as they are.
    var onDismissChip: () -> Void = {}
    /// The field took or gave up the keyboard. The screen that hosts the bar
    /// uses it to put its band away while the keyboard is up, so the bar sits
    /// on the keyboard and not under it.
    var onFocusChange: ((Bool) -> Void)? = nil
    /// The field's id and its Add verb's (`agenda-quick-add` on To-do).
    var fieldIdentifier: String = "tasks-quick-add-field"
    var verbIdentifier: String = "tasks-quick-add-verb"
    /// THE KEYBOARD TOOLBAR (#1173): what its keys send. Nil on a bar that has none.
    var onTool: ((String) -> Void)? = nil
    var onDue: ((String) -> Void)? = nil
    var onTag: ((String) -> Void)? = nil
    /// The Link key's picker, and the × on a staged link or photo.
    var onLink: ((Centraid_Core_V1_LinkEvent) -> Void)? = nil
    var onStagedRemove: ((String) -> Void)? = nil

    @Environment(\.colorScheme) private var scheme
    /// The title field has the keyboard. The toolbar is drawn while it does, or while a tool the
    /// member opened (the tag field) holds it.
    @State private var typing = false

    var body: some View {
        if quickAdd.shown && quickAdd.drawn {
            VStack(spacing: 0) {
                if let onTool, let onDue, let onTag, let onStagedRemove,
                   typing || !quickAdd.openTool.isEmpty || quickAdd.focused || !quickAdd.stagedRows.isEmpty {
                    QuickAddToolbar(
                        quickAdd: quickAdd,
                        onTool: onTool,
                        onDue: onDue,
                        onTag: onTag,
                        onStagedRemove: onStagedRemove
                    )
                }
                field
                if quickAdd.hasChip {
                    QuickAddChipView(chip: quickAdd.chip, onDismiss: onDismissChip)
                }
            }
            // THE LINK KEY'S PICKER: the kit's sheet, open while Rust says so.
            .linkPickerSheet(quickAdd.linkPicker) { link in onLink?(link) }
        }
    }

    private var field: some View {
        let prompt = quickAdd.landsLabel.isEmpty ? placeholder : quickAdd.landsLabel
        return HStack(spacing: 8) {
            // RUST SAYS WHEN THE BAR TAKES THE KEYBOARD: the Plus
            // opened it, or Notes' "Send to Agenda" landed with words in it.
            MachineTextField(
                placeholder: prompt,
                value: quickAdd.title,
                focusOnAppear: quickAdd.focused,
                onEdit: onChange,
                onSubmit: { if quickAdd.canSubmit { onSubmit() } },
                onFocusChange: { now in
                    typing = now
                    // THE TAG FIELD TAKES THE KEYBOARD from the title: that is not the keyboard
                    // leaving, which would put an empty bar away.
                    if now || quickAdd.openTool != "tag" { onFocusChange?(now) }
                },
                keepFocus: onTool != nil
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

/// THE DATE CHIP (#1173 Wave 3): what the typed words will save as, under the
/// quick-add field before Add. A pill in Agenda's tint says the day and time (or
/// the repeat) and the title that is left sits beside it; the × keeps the words as
/// typed. Every word is Rust's. The pill reads as one phrase (`spoken`) and the ×
/// is its own button.
struct QuickAddChipView: View {
    let chip: Centraid_Core_V1_QuickAddChip
    let onDismiss: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let accent = AppAccent("reminders")
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                CentraidIconView(iconKey: chip.repeats ? "Repeat" : "Calendar", tint: accent.text, size: 14)
                    .accessibilityHidden(true)
                Text(chip.label)
                    .centraidType("smallStrong")
                    .foregroundStyle(accent.text)
                    .lineLimit(1)
                Button(action: onDismiss) {
                    CentraidIconView(iconKey: "X", tint: accent.text, size: 14)
                        .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(chip.dismissLabel)
                .accessibilityIdentifier("tasks-quick-add-chip-dismiss")
            }
            .padding(.leading, 10)
            .background(Capsule().fill(accent.wash(dark: scheme == .dark)))
            .accessibilityElement(children: .contain)
            .accessibilityLabel(chip.spoken)
            .accessibilityIdentifier("tasks-quick-add-chip")
            // THE BOARD'S FOOTNOTE: what the words will save as, under the pill.
            Text(chip.savesAs)
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.bottom, 6)
    }
}

/// A list's head line: "7 tasks", and the window's words when the list is a
/// window and not everything.
struct TodoCountLine: View {
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

extension Centraid_Core_V1_TodoCheck {
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
