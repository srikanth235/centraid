import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif

// THE CONTROLS (DESIGN.md "The controls (mobile)").
//
// Chrome is the platform's; content is the kit's. The navigation bar draws its
// own back, title and trailing verb; everything under it is one of these, so
// two apps never draw the same verb two ways. A control here owns its target
// (44), its ink, its stroke and its disabled ink — a screen supplies the words
// and the action and nothing else. A hand-rolled button, chip or check in an
// app is a finding, not a variant.

// MARK: - Icon key

/// A GLYPH THAT DOES ONE THING: a 44 target around an 18 glyph in `text`.
/// `framed` (for a key standing in content, not in a bar) draws a 36 plate on
/// the `md` rung with a `lineStrong` hairline, centred in the target, so it
/// reads as a key and not as decoration.
///
/// Disabled is the `textDisabled` ink on the glyph — never an opacity on the
/// container, which would fade the plate's stroke too and read as absent
/// rather than unavailable.
struct KitIconKey: View {
    let iconKey: String
    let label: String
    var framed: Bool = false
    var tint: String = "text"
    var identifier: String = ""
    let action: () -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        Button(action: action) {
            ZStack {
                if framed {
                    RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                        .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
                        .frame(width: 36, height: 36)
                }
                CentraidIconView(
                    iconKey: iconKey,
                    tint: Theme.color(enabled ? tint : Self.disabledToken, scheme),
                    size: 18
                )
            }
            .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }

    fileprivate static let disabledToken = "textDisabled"
}

// MARK: - Link

/// A VERB THAT READS AS WORDS: the `link` ink, no plate. `dense` is the
/// in-row size (`annotLabelOn`); standing alone it is `smallStrong`. The
/// target is 44 either way — a small word is not a small target.
struct KitLink: View {
    let label: String
    var dense: Bool = false
    var identifier: String = ""
    let action: () -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        Button(action: action) {
            Text(label)
                .centraidType(dense ? "annotLabelOn" : "smallStrong")
                .foregroundStyle(Theme.color(enabled ? "link" : "textDisabled", scheme))
                .frame(minHeight: CentraidGeometry.targetMinCoarse)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
    }
}

// MARK: - Chip

/// THE FACE OF A CHIP, with no button around it, so a `Menu` can wear it.
/// A capsule 32 tall inside a 44 frame. Selected is `bgSunken` + `lineStrong`
/// + `text`, never `accent` — accent is the ink button's alone. The count, when
/// there is one, follows the label in `textFaint`; the chevron says "this opens
/// a choice".
struct KitChipFace: View {
    let label: String
    var count: String = ""
    let selected: Bool
    var chevron: Bool = false

    @Environment(\.colorScheme) private var scheme
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        let ink = enabled ? Theme.color(selected ? "text" : "textSoft", scheme) : Theme.color("textDisabled", scheme)
        let faint = enabled ? Theme.color("textFaint", scheme) : Theme.color("textDisabled", scheme)
        HStack(spacing: 4) {
            Text(label)
                .centraidType(selected ? "smallStrong" : "small")
                .foregroundStyle(ink)
            if !count.isEmpty {
                Text(count)
                    .centraidType("annotLabel")
                    .monospacedDigit()
                    .foregroundStyle(faint)
            }
            if chevron {
                CentraidIconView(iconKey: "ChevronDown", tint: ink, size: 10)
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 32)
        .background(Capsule().fill(Theme.color(selected ? "bgSunken" : "bg", scheme)))
        .overlay(
            Capsule().strokeBorder(
                Theme.color(selected ? "lineStrong" : "line", scheme),
                lineWidth: CentraidGeometry.hairline
            )
        )
        .frame(minHeight: CentraidGeometry.targetMinCoarse)
        .contentShape(Rectangle())
    }
}

/// A FILTER OR A CHOICE AMONG SEVERAL: People's chip, now the only chip.
/// `spoken` overrides the accessibility label when the visible one is short
/// ("Due" → "Due, 3 people").
struct KitChip: View {
    let label: String
    var count: String = ""
    let selected: Bool
    var chevron: Bool = false
    var spoken: String = ""
    var identifier: String = ""
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            KitChipFace(label: label, count: count, selected: selected, chevron: chevron)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(spoken.isEmpty ? label : spoken)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }
}

// MARK: - Segmented

/// ONE OF TWO TO FOUR VIEWS OF THE SAME THING, in the band plate's grammar:
/// one `bgElev` capsule with a `lineStrong` hairline, the lit segment in `text`
/// at the `control` rung with a mark-wide rule over it, the others `textSoft`
/// at `band`. The two rungs share a size, so a tap never reflows the plate.
/// The caller places it (centre, margin); the plate owns nothing outside
/// itself.
struct KitSegmented<Key: Hashable>: View {
    let options: [(key: Key, label: String)]
    let selected: Key
    var identifier: String = ""
    let onSelect: (Key) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: BandMetrics.groupGutter) {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                segment(option.key, option.label)
            }
        }
        .padding(BandMetrics.platePad)
        .background(Theme.color("bgElev", scheme), in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }

    private func segment(_ key: Key, _ label: String) -> some View {
        let active = key == selected
        return Button { onSelect(key) } label: {
            Text(label)
                .centraidType(active ? "control" : "band")
                .foregroundStyle(Theme.color(active ? "text" : "textSoft", scheme))
                .lineLimit(1)
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .frame(minHeight: CentraidGeometry.targetMinCoarse)
                .overlay(alignment: .top) {
                    if active {
                        Capsule()
                            .fill(Theme.color("text", scheme))
                            .frame(width: BandMetrics.markSize, height: BandMetrics.activeRule)
                            .padding(.top, CentraidGeometry.hairline)
                    }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(active ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier(identifier.isEmpty ? "" : "\(identifier)-\(label.lowercased())")
    }
}

// MARK: - Stepper

/// PREVIOUS / NEXT: two framed icon keys, ‹ ›, 8 apart. A bound that is
/// reached disables its key (the glyph goes `textDisabled`) rather than
/// hiding it, so the pair never moves.
struct KitStepper: View {
    let previousLabel: String
    let nextLabel: String
    var canPrevious: Bool = true
    var canNext: Bool = true
    var previousIdentifier: String = ""
    var nextIdentifier: String = ""
    let onPrevious: () -> Void
    let onNext: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            KitIconKey(iconKey: "ChevronLeft", label: previousLabel, framed: true, identifier: previousIdentifier, action: onPrevious)
                .disabled(!canPrevious)
            KitIconKey(iconKey: "ChevronRight", label: nextLabel, framed: true, identifier: nextIdentifier, action: onNext)
                .disabled(!canNext)
        }
    }
}

// MARK: - Check box

/// WHAT A CHECK SHOWS: `off` an empty outline; `on` an `accent` fill with a
/// check; `mixed` an `accent` fill with a dash (set aside — a task won't-do);
/// `partial` the outline with its left half `accent` (begun, not done).
enum KitCheckState {
    case off, on, mixed, partial
}

/// A CHOICE THAT IS ON OR OFF: a 20 box on the `sm` rung — a `lineStrong`
/// 1.5 outline when off, `accent` fill with a `onAccent` check when on —
/// inside a 44 target. The label is spoken only; the row beside it says the
/// words. `state` adds the two in-between faces (`mixed`, `partial`).
/// Disabled is `textDisabled` on the outline and the mark.
struct KitCheckBox: View {
    let state: KitCheckState
    let label: String
    var identifier: String = ""
    let action: () -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.isEnabled) private var enabled

    init(state: KitCheckState, label: String, identifier: String = "", action: @escaping () -> Void) {
        self.state = state
        self.label = label
        self.identifier = identifier
        self.action = action
    }

    init(checked: Bool, label: String, identifier: String = "", action: @escaping () -> Void) {
        self.init(state: checked ? .on : .off, label: label, identifier: identifier, action: action)
    }

    var body: some View {
        let radius = Theme.radius("sm", scheme)
        let fill = Theme.color(enabled ? "accent" : "textDisabled", scheme)
        let outline = Theme.color(enabled ? "lineStrong" : "textDisabled", scheme)
        let mark = Theme.color(enabled ? "onAccent" : "bg", scheme)
        Button(action: action) {
            ZStack {
                switch state {
                case .on:
                    RoundedRectangle(cornerRadius: radius).fill(fill)
                    CentraidIconView(iconKey: "Check", tint: mark, size: 14)
                case .mixed:
                    RoundedRectangle(cornerRadius: radius).fill(fill)
                    Rectangle().fill(mark).frame(width: 10, height: 1.5)
                case .partial:
                    RoundedRectangle(cornerRadius: radius)
                        .fill(fill)
                        .mask(alignment: .leading) { Rectangle().frame(width: 10) }
                    RoundedRectangle(cornerRadius: radius).strokeBorder(outline, lineWidth: 1.5)
                case .off:
                    RoundedRectangle(cornerRadius: radius).strokeBorder(outline, lineWidth: 1.5)
                }
            }
            .frame(width: 20, height: 20)
            .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(state == .on || state == .mixed ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }
}

// MARK: - Switch

private struct KitToggleStyle: ViewModifier {
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        content.tint(Theme.color("accent", scheme))
    }
}

extension View {
    /// A SWITCH IN `accent` WHEN ON. The system switch's green is nobody's
    /// palette; accent is the one "on" in the kit.
    func kitToggle() -> some View {
        modifier(KitToggleStyle())
    }
}

// MARK: - Root tint

private struct KitRootTint: ViewModifier {
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        content.tint(Theme.color("link", scheme))
    }
}

extension View {
    /// THE ROOT'S TINT: `link` ink, so every platform control (a bar's back
    /// and verbs, a menu, a picker) is on-palette rather than system blue.
    /// Applied once, at the root.
    func kitRootTint() -> some View {
        modifier(KitRootTint())
    }
}

// MARK: - Toolbar

/// A WORD IN THE NAVIGATION BAR. A plain system button with no style and no
/// font: the bar draws it (glass on iOS), so a screen that styles it is
/// fighting the platform. Its ink is `text`, not the root's `link`: a bar
/// verb sits beside the back chevron, the bar glyphs and an editor's close,
/// all of which are `text`, and one blue word among them reads as a link.
/// The bar still greys it when disabled.
struct ToolbarVerb: View {
    let label: String
    var identifier: String = ""
    let action: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(label, action: action)
            .tint(Theme.color("text", scheme))
            .accessibilityIdentifier(identifier)
    }
}

/// A GLYPH IN THE NAVIGATION BAR: 18, `text`, no frame and no style — the bar
/// gives it its target and its glass.
struct ToolbarIcon: View {
    let iconKey: String
    let label: String
    var identifier: String = ""
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ToolbarIconFace(iconKey: iconKey)
        }
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }
}

/// THE BAR GLYPH ALONE, for a `Menu` label.
struct ToolbarIconFace: View {
    let iconKey: String

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        CentraidIconView(iconKey: iconKey, tint: Theme.color("text", scheme), size: 18)
    }
}

// MARK: - In-flight progress

/// A WRITE OR A TRANSFER IN FLIGHT: a small turning ring in `textSoft`, with an
/// optional label beside it in `small` `textSoft`. Loading a screen is a
/// skeleton (`ReadStateView`) — a spinner cannot say what shape is coming, so
/// it is reserved for work that has no shape to draw: a save running, a
/// download starting. The label, when there is one, is the accessibility label;
/// a bare ring says nothing to VoiceOver, so it is named.
struct KitSpinner: View {
    var label: String = ""

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
                .tint(Theme.color("textSoft", scheme))
            if !label.isEmpty {
                Text(label)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }
}

/// HOW FAR A TRANSFER HAS GOT, WHEN ANYONE CAN SAY: a 2pt bar on the `sm`
/// rung, `accent` on `bgSunken` — the rule of a progress line, not a control.
/// `fraction` is clamped to 0...1; when nobody can say how far, draw
/// `KitSpinner`, never a bar stuck at zero. `onStage` re-inks it for the photo
/// stage's dark ground (`onStage` on `onStageSoft`), where accent and
/// `bgSunken` would be the wrong palette.
struct KitProgressBar: View {
    let fraction: Double
    var onStage: Bool = false

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let clamped = min(max(fraction, 0), 1)
        let shape = RoundedRectangle(cornerRadius: Theme.radius("sm", scheme))
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                shape.fill(Theme.color(onStage ? "onStageSoft" : "bgSunken", scheme))
                shape
                    .fill(Theme.color(onStage ? "onStage" : "accent", scheme))
                    .frame(width: proxy.size.width * clamped)
            }
        }
        .frame(height: 2)
        .clipShape(shape)
        .accessibilityElement(children: .ignore)
        .accessibilityValue("\(Int((clamped * 100).rounded())) percent")
    }
}

/// THE SPINNER ON THE PHOTO STAGE: `KitSpinner`'s ring and label in the
/// stage's own inks — `onStage` for the ring, `onStageSoft` for the label — so
/// a download under a photograph is legible on its dark ground in either
/// appearance.
struct StageSpinner: View {
    var label: String = ""

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
                .tint(Theme.color("onStage", scheme))
            if !label.isEmpty {
                Text(label)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("onStageSoft", scheme))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }
}
