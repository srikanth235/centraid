import SwiftUI
import UIKit

/// THE NOTE'S BODY, DRAWN FROM RUST'S SPANS (#1173).
///
/// A `UITextView` whose text is the Markdown body and whose look is `state.rich`: the core's
/// blocks and spans, in UTF-16 code units, which is `NSString`'s own unit, so a range is applied
/// with no conversion. Nothing here parses Markdown and nothing here words anything. The shell
/// draws what it is told and sends the member's gestures back as events:
///
/// - **A checklist circle** is drawn over the line's `[ ]` / `[x]`, and a tap on it is
///   `checklist_toggled`. The text is never changed to draw it (no attachment, no inserted
///   character), so every offset the core holds stays the text's.
/// - **A link chip** is the span restyled; a tap on it is `link_opened`, except a resolved note,
///   whose route the shell opens as it opens History.
/// - **Return** at a collapsed caret is `return_pressed`; the core edits the body and answers
///   with the body and a `selection` the shell applies once per `seq`.
///
/// **THE SPANS ARE OF A BODY THE CORE HEARD.** Between a keystroke and the state that follows it
/// the text is longer or shorter than `body_length`, and the body is drawn plain until the next
/// state (the proto's own rule); the circles go with it. While the keyboard holds marked text
/// (an IME composing) nothing is restyled, so the composition is not broken.
struct NotesRichBody: UIViewRepresentable {
    /// The body the machine holds.
    let value: String
    let rich: Centraid_Core_V1_NotesRichText?
    let selection: Centraid_Core_V1_NotesEditorSelection?
    /// The machine's body may replace the typed one now: the field is not being typed in, or a
    /// core edit (a checklist tap, Return, Undo, a pick) is on its way back.
    let follows: Bool
    @Binding var focused: Bool
    let label: String
    let onEdit: (String) -> Void
    let onEmpty: (Bool) -> Void
    let onAdopted: () -> Void
    let onReturn: (UInt32) -> Void
    let onToggle: (UInt32) -> Void
    let onLink: (Centraid_Core_V1_NotesLinkChip, UInt32) -> Void

    func makeUIView(context: Context) -> NotesRichTextView {
        let view = NotesRichTextView()
        view.delegate = context.coordinator
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.accessibilityIdentifier = "note-body-field"
        view.accessibilityLabel = label
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:)))
        tap.delegate = context.coordinator
        view.addGestureRecognizer(tap)
        context.coordinator.appliedSeq = selection?.seq ?? 0
        view.onActivateCheck = { [weak coordinator = context.coordinator] at in coordinator?.parent.onToggle(at) }
        view.onActivateChip = { [weak coordinator = context.coordinator] chip, at in coordinator?.parent.onLink(chip, at) }
        return view
    }

    func updateUIView(_ view: NotesRichTextView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        let env = context.environment
        let palette = NotesRichPalette(scheme: env.colorScheme, size: env.dynamicTypeSize, accent: env.appAccent)
        coordinator.palette = palette
        view.accessibilityLabel = label

        if view.markedTextRange == nil {
            if let typed = coordinator.typed {
                if let adopted = typed.answer(value: value, shown: view.text, open: follows) {
                    coordinator.adopt(adopted, into: view)
                }
            } else {
                coordinator.typed = TypedText(initial: value)
                coordinator.adopt(value, into: view)
            }
        }
        coordinator.restyle(view)
        // THE CARET, ONCE PER `seq`: after the body it belongs to.
        if let selection, selection.seq > coordinator.appliedSeq {
            coordinator.appliedSeq = selection.seq
            let length = (view.text as NSString).length
            view.selectedRange = NSRange(location: min(Int(selection.caret), length), length: 0)
        }
        if focused, !view.isFirstResponder {
            DispatchQueue.main.async { view.becomeFirstResponder() }
        } else if !focused, view.isFirstResponder {
            DispatchQueue.main.async { view.resignFirstResponder() }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: NotesRichTextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite, width > 0 else { return nil }
        let fit = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: fit.height)
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate, UIGestureRecognizerDelegate {
        var parent: NotesRichBody
        var typed: TypedText?
        var palette: NotesRichPalette?
        var appliedSeq: UInt64 = 0

        init(parent: NotesRichBody) { self.parent = parent }

        /// The machine's words replace the text: the caret stays where it was, inside the new text.
        func adopt(_ text: String, into view: NotesRichTextView) {
            let before = view.selectedRange
            view.text = text
            let length = (text as NSString).length
            view.selectedRange = NSRange(location: min(before.location, length), length: 0)
            reportEmpty(view)
            Task { @MainActor [weak self] in self?.parent.onAdopted() }
        }

        private func reportEmpty(_ view: UITextView) {
            let empty = view.text.isEmpty
            Task { @MainActor [weak self] in self?.parent.onEmpty(empty) }
        }

        // MARK: Drawing

        func restyle(_ view: NotesRichTextView) {
            guard view.markedTextRange == nil, let palette else { return }
            let storage = view.textStorage
            let length = storage.length
            let full = NSRange(location: 0, length: length)
            var checks: [NotesRichTextView.Check] = []
            var chips: [NotesRichTextView.Chip] = []
            storage.beginEditing()
            storage.setAttributes(palette.base, range: full)
            if let rich = parent.rich, Int(rich.bodyLength) == length {
                for block in rich.blocks { style(block, in: storage, length: length, palette: palette, checks: &checks) }
                for span in rich.spans { style(span, in: storage, length: length, palette: palette, chips: &chips) }
            }
            storage.endEditing()
            view.typingAttributes = palette.base
            view.checkFill = palette.checkFill
            view.checkRing = palette.checkRing
            view.checkInk = palette.checkInk
            view.setMarks(checks: checks, chips: chips)
        }

        private func range(_ r: Centraid_Core_V1_NotesTextRange, _ length: Int) -> NSRange? {
            let start = Int(r.start), end = Int(r.end)
            guard start <= end, end <= length else { return nil }
            return NSRange(location: start, length: end - start)
        }

        private func style(
            _ block: Centraid_Core_V1_NotesRichBlock,
            in storage: NSTextStorage,
            length: Int,
            palette: NotesRichPalette,
            checks: inout [NotesRichTextView.Check]
        ) {
            guard let line = range(block.range, length) else { return }
            let marker = block.hasMarker ? range(block.marker, length) : nil
            let content = block.hasContent ? range(block.content, length) : nil
            switch block.kind {
            case .heading:
                // Heading 1 and 2 take the section rung, the rest the row's semibold.
                storage.addAttribute(.font, value: block.level <= 2 ? palette.section : palette.strong, range: line)
                if let marker { storage.addAttribute(.foregroundColor, value: palette.faint, range: marker) }
            case .checklist:
                guard let marker else { return }
                // The line's lead (an indent, the dash) and the `[ ]` are drawn clear: the circle
                // stands where the `[ ]` is, and the words follow after a gap.
                let lead = NSRange(location: line.location, length: marker.location + marker.length - line.location)
                storage.addAttribute(.foregroundColor, value: UIColor.clear, range: lead)
                let after = marker.location + marker.length
                if after < line.location + line.length {
                    storage.addAttribute(.kern, value: palette.gap, range: NSRange(location: after, length: 1))
                }
                if block.checked, let content {
                    storage.addAttributes(
                        [.foregroundColor: palette.faint, .strikethroughStyle: NSUnderlineStyle.single.rawValue],
                        range: content
                    )
                }
                checks.append(.init(marker: marker, checked: block.checked, label: block.accessibilityLabel))
            case .bullet:
                if let marker { storage.addAttribute(.foregroundColor, value: palette.accentText, range: marker) }
            case .quote:
                if let marker { storage.addAttribute(.foregroundColor, value: palette.faint, range: marker) }
                if let content { storage.addAttribute(.foregroundColor, value: palette.bodyInk, range: content) }
            default:
                break
            }
        }

        private func style(
            _ span: Centraid_Core_V1_NotesRichSpan,
            in storage: NSTextStorage,
            length: Int,
            palette: NotesRichPalette,
            chips: inout [NotesRichTextView.Chip]
        ) {
            guard let at = range(span.range, length), at.length > 0 else { return }
            switch span.style {
            case .emphasis: storage.addAttribute(.obliqueness, value: palette.slant, range: at)
            case .strong: storage.addAttribute(.font, value: palette.strong, range: at)
            case .strike: storage.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: at)
            case .code:
                storage.addAttributes([.font: palette.code, .backgroundColor: palette.codeGround], range: at)
            case .syntax: storage.addAttribute(.foregroundColor, value: palette.faint, range: at)
            case .link:
                guard span.hasChip else { return }
                let chip = span.chip
                switch (chip.kind, chip.resolution) {
                case (.url, _):
                    storage.addAttributes(
                        [.foregroundColor: palette.accentText, .underlineStyle: NSUnderlineStyle.single.rawValue],
                        range: at
                    )
                case (_, .trashed):
                    storage.addAttributes(
                        [.foregroundColor: palette.faint, .strikethroughStyle: NSUnderlineStyle.single.rawValue],
                        range: at
                    )
                case (_, .missing):
                    storage.addAttribute(.foregroundColor, value: palette.missing, range: at)
                default:
                    storage.addAttributes(
                        [.foregroundColor: palette.accentText, .backgroundColor: palette.chipGround, .font: palette.strong],
                        range: at
                    )
                }
                chips.append(.init(range: at, chip: chip))
            default:
                break
            }
        }

        // MARK: Text view

        func textViewDidChange(_ view: UITextView) {
            guard let view = view as? NotesRichTextView else { return }
            if typed?.edited(next: view.text) == true { parent.onEdit(view.text) }
            reportEmpty(view)
            // The spans are of the body the core heard: plain until its next state.
            restyle(view)
        }

        func textViewDidBeginEditing(_ view: UITextView) {
            Task { @MainActor [weak self] in self?.parent.focused = true }
        }

        func textViewDidEndEditing(_ view: UITextView) {
            Task { @MainActor [weak self] in self?.parent.focused = false }
        }

        func textView(_ view: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            // RETURN AT A CARET IS THE CORE'S EDIT (a new list line, or the list ended); a paste, or
            // Return over a selection, is an ordinary edit of the words.
            guard text == "\n", range.length == 0, view.markedTextRange == nil else { return true }
            parent.onReturn(UInt32(range.location))
            return false
        }

        // MARK: Taps

        func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            true
        }

        @objc func tapped(_ gesture: UITapGestureRecognizer) {
            guard gesture.state == .ended, let view = gesture.view as? NotesRichTextView else { return }
            let point = gesture.location(in: view)
            switch view.hit(at: point) {
            case let .check(at)?: parent.onToggle(at)
            case let .chip(chip, at)?: parent.onLink(chip, at)
            case nil: break
            }
        }
    }
}

/// THE BODY'S FACES AND COLOURS, all from the kit: the row rung and the section rung, the
/// surface inks, the app's accent and the state red.
struct NotesRichPalette {
    let base: [NSAttributedString.Key: Any]
    let section: UIFont
    let strong: UIFont
    let code: UIFont
    let faint: UIColor
    let bodyInk: UIColor
    let accentText: UIColor
    let chipGround: UIColor
    let codeGround: UIColor
    let missing: UIColor
    let checkFill: UIColor
    let checkRing: UIColor
    let checkInk: UIColor
    /// The space after a checklist circle, a half of the face's size.
    let gap: CGFloat
    let slant: CGFloat = 0.2

    init(scheme: ColorScheme, size: DynamicTypeSize, accent: AppAccent) {
        let resolved = Theme.resolve(KitType.row.role, scheme, size)
        let font = resolved.font
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = max(0, resolved.lineHeight - font.lineHeight)
        let ink = UIColor(Surface.ink)
        base = [.font: font, .foregroundColor: ink, .paragraphStyle: paragraph]
        section = Theme.uiFont(KitType.section.role, scheme, size)
        strong = Theme.face(for: CentraidTypeStyle(family: "sans", fontSize: font.pointSize, lineHeight: resolved.lineHeight, weight: 600))
        code = Theme.face(for: CentraidTypeStyle(family: "code", fontSize: font.pointSize, lineHeight: resolved.lineHeight, weight: 400))
        faint = UIColor(Surface.meta)
        bodyInk = UIColor(Surface.body)
        accentText = UIColor(accent.text)
        chipGround = UIColor(accent.wash(dark: scheme == .dark))
        codeGround = UIColor(Surface.fill)
        missing = UIColor(StateColor.red.text)
        checkFill = UIColor(accent.fill)
        checkRing = UIColor(Surface.meta)
        checkInk = UIColor.white
        gap = font.pointSize / 2
    }
}

/// THE TEXT VIEW, with the checklist circles and the chips' accessibility marks laid over it.
///
/// A mark is placed from the text's own geometry (`firstRect`), after every layout, and never
/// changes the text: the offsets in it are the core's.
final class NotesRichTextView: UITextView {
    struct Check {
        let marker: NSRange
        let checked: Bool
        let label: String
    }

    struct Chip {
        let range: NSRange
        let chip: Centraid_Core_V1_NotesLinkChip
    }

    enum Hit {
        case check(at: UInt32)
        case chip(Centraid_Core_V1_NotesLinkChip, at: UInt32)
    }

    /// Bounds on what is laid over a very large note: the marks beyond are drawn as text.
    private static let markLimit = 400

    var checkFill = UIColor.clear
    var checkRing = UIColor.clear
    var checkInk = UIColor.clear
    private var checks: [Check] = []
    private var chips: [Chip] = []
    private var circles: [NotesCheckMark] = []
    private var chipMarks: [NotesChipMark] = []

    func setMarks(checks: [Check], chips: [Chip]) {
        self.checks = Array(checks.prefix(Self.markLimit))
        self.chips = Array(chips.prefix(Self.markLimit))
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        placeMarks()
    }

    private func textRange(_ range: NSRange) -> UITextRange? {
        guard let start = position(from: beginningOfDocument, offset: range.location),
            let end = position(from: start, offset: range.length)
        else { return nil }
        return textRange(from: start, to: end)
    }

    private func marker(_ check: Check) -> CGRect? {
        guard let range = textRange(check.marker) else { return nil }
        let rect = firstRect(for: range)
        return rect.isNull || rect.isInfinite || rect.isEmpty ? nil : rect
    }

    private func placeMarks() {
        while circles.count > checks.count { circles.removeLast().removeFromSuperview() }
        while circles.count < checks.count {
            let mark = NotesCheckMark()
            addSubview(mark)
            circles.append(mark)
        }
        for (at, check) in checks.enumerated() {
            let mark = circles[at]
            guard let rect = marker(check) else {
                mark.isHidden = true
                continue
            }
            let side = min(rect.width, rect.height)
            mark.isHidden = false
            mark.frame = CGRect(x: rect.minX, y: rect.midY - side / 2, width: side, height: side)
            mark.checked = check.checked
            mark.fill = checkFill
            mark.ring = checkRing
            mark.ink = checkInk
            mark.accessibilityLabel = check.label
            mark.accessibilityIdentifier = "notes-check-\(check.marker.location)"
            mark.onActivate = { [weak self] in self?.onActivateCheck?(UInt32(check.marker.location)) }
            mark.setNeedsDisplay()
        }
        while chipMarks.count > chips.count { chipMarks.removeLast().removeFromSuperview() }
        while chipMarks.count < chips.count {
            let mark = NotesChipMark()
            addSubview(mark)
            chipMarks.append(mark)
        }
        for (at, item) in chips.enumerated() {
            let mark = chipMarks[at]
            guard let range = textRange(item.range) else {
                mark.isHidden = true
                continue
            }
            let rect = firstRect(for: range)
            mark.isHidden = rect.isNull || rect.isInfinite || rect.isEmpty
            mark.frame = rect
            mark.accessibilityLabel = item.chip.accessibilityLabel
            mark.accessibilityIdentifier = "notes-chip-\(item.range.location)"
            mark.onActivate = { [weak self] in self?.onActivateChip?(item.chip, UInt32(item.range.location)) }
        }
    }

    var onActivateCheck: ((UInt32) -> Void)?
    var onActivateChip: ((Centraid_Core_V1_NotesLinkChip, UInt32) -> Void)?

    /// What a tap at `point` lands on: a chip's words, or a checklist circle (its press widened to
    /// a thumb's target), whichever is nearer a line's middle.
    func hit(at point: CGPoint) -> Hit? {
        for item in chips {
            guard let range = textRange(item.range) else { continue }
            if selectionRects(for: range).contains(where: { $0.rect.contains(point) }) {
                return .chip(item.chip, at: UInt32(item.range.location))
            }
        }
        var best: (distance: CGFloat, at: UInt32)?
        for check in checks {
            guard let rect = marker(check) else { continue }
            let reach = CentraidGeometry.targetMinCoarse
            let target = rect.insetBy(dx: -max(0, (reach - rect.width) / 2), dy: -max(0, (reach - rect.height) / 2))
            guard target.contains(point) else { continue }
            let distance = abs(point.y - rect.midY)
            if best == nil || distance < best!.distance { best = (distance, UInt32(check.marker.location)) }
        }
        return best.map { .check(at: $0.at) }
    }
}

/// A CHECKLIST CIRCLE: the app's fill under a white tick once done, a ring while not. It is
/// drawn, not a control: a tap reaches it as the text view's, and a screen reader activates it.
private final class NotesCheckMark: UIView {
    var checked = false
    var fill = UIColor.clear
    var ring = UIColor.clear
    var ink = UIColor.clear
    var onActivate: () -> Void = {}

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        isUserInteractionEnabled = false
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func accessibilityActivate() -> Bool {
        onActivate()
        return true
    }

    override func draw(_ rect: CGRect) {
        let side = min(bounds.width, bounds.height)
        guard side > 0 else { return }
        let ringWidth = CentraidGeometry.hairline * 1.5
        let circle = CGRect(x: (bounds.width - side) / 2, y: (bounds.height - side) / 2, width: side, height: side)
        if checked {
            fill.setFill()
            UIBezierPath(ovalIn: circle).fill()
            let tick = UIBezierPath()
            tick.move(to: CGPoint(x: circle.minX + side * 0.28, y: circle.minY + side * 0.52))
            tick.addLine(to: CGPoint(x: circle.minX + side * 0.43, y: circle.minY + side * 0.67))
            tick.addLine(to: CGPoint(x: circle.minX + side * 0.72, y: circle.minY + side * 0.34))
            tick.lineWidth = ringWidth * 1.5
            tick.lineCapStyle = .round
            tick.lineJoinStyle = .round
            ink.setStroke()
            tick.stroke()
        } else {
            ring.setStroke()
            let path = UIBezierPath(ovalIn: circle.insetBy(dx: ringWidth / 2, dy: ringWidth / 2))
            path.lineWidth = ringWidth
            path.stroke()
        }
    }
}

/// A CHIP'S ACCESSIBILITY MARK: invisible, over the chip's words, so a screen reader reads the
/// core's label ("Note Lisbon itinerary") and can open it.
private final class NotesChipMark: UIView {
    var onActivate: () -> Void = {}

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isAccessibilityElement = true
        accessibilityTraits = .link
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func accessibilityActivate() -> Bool {
        onActivate()
        return true
    }
}
