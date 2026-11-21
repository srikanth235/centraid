import SwiftUI
import XCTest

@testable import CentraidApp

/// BOLD TEXT, PROVED WITHOUT THE SYSTEM SWITCH (#1202). A simulator never reports
/// `UIAccessibility.isBoldTextEnabled`, so the audit cannot run under it. These tests lay out
/// the key text views of Home and Calendar with `legibilityWeight` set to `.bold` (the environment
/// value Bold Text drives) at the default size and at the app's largest, on an iPhone-width
/// screen, and assert what a member would see go wrong: a label wider than the screen (it
/// would be cut or pushed off an edge), a row that no longer fits its width, or a line box that
/// grows past what a heavier face can need.
@MainActor
final class BoldTextLayoutTests: XCTestCase {
    /// An iPhone 17 Pro's width, the narrowest the shell is drawn at in the audit.
    private let screen: CGFloat = 393

    private func fit<V: View>(_ view: V, bold: Bool, size: DynamicTypeSize, width: CGFloat?) -> CGSize {
        let host = UIHostingController(
            rootView: view
                .environment(\.legibilityWeight, bold ? .bold : .regular)
                .environment(\.dynamicTypeSize, size)
        )
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: screen, height: 852))
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.layoutIfNeeded()
        return host.sizeThatFits(in: CGSize(width: width ?? .greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
    }

    /// The view's ideal width (one proposal of "as wide as you like") is what a single-line row
    /// needs; it fits when that is no more than the screen, and bold is no more than a few points
    /// wider than regular (a heavier face is a little wider, never a different layout).
    private func assertFits<V: View>(_ name: String, _ view: V, sizes: [DynamicTypeSize], file: StaticString = #filePath, line: UInt = #line) {
        for size in sizes {
            let regular = fit(view, bold: false, size: size, width: screen)
            let bold = fit(view, bold: true, size: size, width: screen)
            XCTAssertLessThanOrEqual(bold.width, screen + 0.5, "\(name) at \(size): bold is wider than the screen", file: file, line: line)
            XCTAssertLessThanOrEqual(bold.height, regular.height * 1.25 + 2, "\(name) at \(size): bold grew from \(regular.height) to \(bold.height)", file: file, line: line)
            // THE IDEAL WIDTH: a single-line label that wants more than the screen is a label cut off.
            let wide = fit(view, bold: true, size: size, width: nil)
            XCTAssertLessThanOrEqual(wide.width, screen + 0.5, "\(name) at \(size): bold wants \(wide.width) pt in one line", file: file, line: line)
        }
    }

    private let places = ["home": "Home", "chat": "Chat", "backup": "Backup", "more": "More"]
        .sorted { $0.key < $1.key }
        .enumerated()
        .map { index, pair in
            BandPlace(id: pair.key, label: pair.value, spoken: pair.value, iconKey: "Home", selected: index == 0)
        }

    // MARK: Home

    func testHomeBandHoldsItsLabelsUnderBoldText() {
        assertFits("Home band", HomeBand(places: places) { _ in }, sizes: [.large, .accessibility3])
    }

    func testHomeBandFivePlacesUnderBoldText() {
        let five = ["Home", "Chat", "Calendar", "Backup", "More"].enumerated().map { index, label in
            BandPlace(id: label.lowercased(), label: label, spoken: label, iconKey: "Home", selected: index == 0)
        }
        assertFits("Home band, five places", HomeBand(places: five) { _ in }, sizes: [.large, .accessibility3])
    }

    // MARK: Calendar

    private func strip() -> Centraid_Core_V1_AgendaWeekStrip {
        var strip = Centraid_Core_V1_AgendaWeekStrip()
        for (index, initial) in ["M", "T", "W", "T", "F", "S", "S"].enumerated() {
            var day = Centraid_Core_V1_AgendaStripDay()
            day.day = "2026-11-\(16 + index)"
            day.weekdayInitial = initial
            day.dayNumber = "\(16 + index)"
            day.isToday = index == 3
            day.isSelected = index == 3
            day.isWeekend = index > 4
            day.accessibilityLabel = "\(initial) \(16 + index)"
            strip.days.append(day)
        }
        return strip
    }

    func testCalendarWeekStripUnderBoldText() {
        assertFits("Calendar week strip", AgendaWeekStripView(strip: strip()) { _ in }, sizes: [.large, .accessibility3])
    }

    func testCalendarHeaderKeysUnderBoldText() {
        var header = Centraid_Core_V1_AgendaCalendarHeader()
        header.monthLabel = "November"
        header.monthIconKey = "ChevronLeft"
        header.monthAccessibility = "Back to November"
        assertFits("Calendar month chip", AgendaMonthChip(header: header) { _ in }, sizes: [.large, .accessibility3])
    }

    // MARK: What the audit's Dynamic Type exemption for the Home eyebrow rests on

    /// The 11pt eyebrow is the system's caption2 face, which UIFontMetrics holds at 11pt for the four
    /// smallest text sizes. A comparison that steps through the sizes reads that as "partially
    /// unsupported", and `AccessibilityAuditTests` exempts the weekday eyebrow for it. If the system
    /// ever scales the face at every step, this fails and the exemption goes.
    func testCaption2HoldsItsSizeAcrossTheSmallestSizes() {
        let sizes: [UIContentSizeCategory] = [.extraSmall, .small, .medium, .large]
        let points = sizes.map {
            UIFontMetrics(forTextStyle: .caption2).scaledValue(for: 11, compatibleWith: UITraitCollection(preferredContentSizeCategory: $0))
        }
        XCTAssertEqual(Set(points).count, 1, "caption2 sizes \(points)")
    }
}
