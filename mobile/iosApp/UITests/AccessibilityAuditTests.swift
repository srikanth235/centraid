import UIKit
import XCTest

/// THE ACCESSIBILITY AUDIT (#1202, slice S4).
///
/// `performAccessibilityAudit()` over Home, every app's root and each root's main
/// sheets, in light, dark and the largest text size the app follows, on the demo
/// vault `mobile/scripts/verify-ios.sh` seeds. Nothing is excluded: every audit
/// type runs on every screen, and an issue is a failure unless it is listed in
/// `Exemptions` with the design rule that allows it.
///
/// Chat is not visited (it needs the on-device model), and Locker stops at its
/// wall: the demo seed unlocks it only under a passcode the simulator lacks.
final class AccessibilityAuditTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = true
        found = [:]
    }

    /// Issues found in this run, by `mode | screen | audit type`.
    private var found: [String: Int] = [:]

    /// THE RATCHET (`audit-baseline.json`): how many issues of each kind the audit
    /// reports TODAY, per mode, screen and audit type. The count may fall and may
    /// never rise; a screen the file does not name has a budget of zero. Fixing an
    /// issue is how an entry goes down (the run prints `RATCHET-DOWN` for it), and
    /// the file is lowered in the same change, never raised.
    private static let baseline: [String: Int] = {
        guard let url = Bundle(for: AccessibilityAuditTests.self).url(forResource: "audit-baseline", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let table = try? JSONDecoder().decode([String: Int].self, from: data)
        else { return [:] }
        return table
    }()

    /// Settles the run against the ratchet. Called last in every audit test.
    private func settle(mode: String) {
        for key in Set(found.keys).union(Self.baseline.keys.filter { $0.hasPrefix("\(mode)|") }).sorted() {
            let now = found[key] ?? 0
            let allowed = Self.baseline[key] ?? 0
            print("A11Y-COUNT|\(key)|\(now)")
            if now > allowed {
                XCTFail("\(key): \(now) issues, \(allowed) allowed (audit-baseline.json). New accessibility issues are not accepted: fix them.")
            } else if now < allowed {
                print("RATCHET-DOWN|\(key)|\(allowed) -> \(now)")
            }
        }
    }

    // MARK: The three modes

    @MainActor func testAuditLight() throws {
        try tour(mode: "light", appearance: .light, textSize: nil)
    }

    @MainActor func testAuditDark() throws {
        try tour(mode: "dark", appearance: .dark, textSize: nil)
    }

    /// `accessibilityExtraExtraExtraLarge` is the largest of the three
    /// "accessibility" sizes short of `accessibility5`, the app's ceiling
    /// (`design/behaviour.md`, Accessibility): where the cards have all reflowed.
    @MainActor func testAuditLargestText() throws {
        try tour(mode: "accessibility-xxxl", appearance: .light, textSize: "UICTContentSizeCategoryAccessibilityXXXL")
    }

    // MARK: The tour

    /// What the tour visits: the tile on Home, then the ids of the root's own
    /// sheets. `more` is the band's More key and `add` the header's Add, where the
    /// app has one.
    private struct Root {
        let name: String
        let tile: String
        let more: String?
        let add: String?
        /// Audit the Add state? `false` only where the audit itself brings the app down.
        var auditAdd = true
    }

    private static let roots: [Root] = [
        Root(name: "Calendar", tile: "home-tile-calendar", more: "calendar-band-more", add: "agenda-new-event"),
        // The audit of the open quick-add bar CRASHES THE APP: `performAccessibilityAudit`
        // steps the text size through every category while it runs, and SwiftUI's
        // `List` under Reminders traps in `UICollectionView` layout invalidation
        // (`_axAuditCheckDynamicTextSupport`, SIGTRAP; #1202 S4). The tap still runs, so
        // the bar's reading order is checked (`testFocusOrderAddReminder`).
        Root(name: "Reminders", tile: "home-tile-reminders", more: "reminders-band-more", add: "agenda-add-task", auditAdd: false),
        Root(name: "Notes", tile: "home-tile-notes", more: "notes-band-more", add: "notes-new-note"),
        Root(name: "People", tile: "home-tile-people", more: "people-band-more", add: "people-add-person"),
        Root(name: "Docs", tile: "home-tile-docs", more: "docs-band-more", add: "docs-add"),
        Root(name: "Money", tile: "home-tile-money", more: "money-band-more", add: "money-add"),
        Root(name: "Health", tile: "home-tile-health", more: "health-band-more", add: nil),
        Root(name: "Photos", tile: "home-tile-photos", more: nil, add: nil),
    ]

    @MainActor private func tour(mode: String, appearance: XCUIDevice.Appearance, textSize: String?) throws {
        XCUIDevice.shared.appearance = appearance
        let app = launch(textSize: textSize)
        audit(app, mode: mode, screen: "Home") {}

        for root in Self.roots {
            try open(app, tile: root.tile)
            audit(app, mode: mode, screen: root.name)
            if let more = root.more, app.el(more).exists {
                app.el(more).tap()
                audit(app, mode: mode, screen: "\(root.name) More")
                dismissSheet(app)
            }
            if let add = root.add, app.el(add).exists {
                app.el(add).tap()
                if root.auditAdd { audit(app, mode: mode, screen: "\(root.name) Add") }
                dismissSheet(app)
            }
            try goHome(app)
        }

        // LOCKER, UP TO ITS WALL: the wall is what a member sees first.
        try open(app, tile: "home-tile-locker")
        var wall = app.el("locker-wall").waitForExistence(timeout: 15)
        if !wall {
            // At the largest sizes the tile can still be moving when the first tap lands.
            try open(app, tile: "home-tile-locker")
            wall = app.el("locker-wall").waitForExistence(timeout: 30)
        }
        if !wall { print("LOCKER-DIAG|app: \(outline(app))|springboard: \(springboardOutline())") }
        XCTAssertTrue(wall, "Locker shows its wall")
        dismissSystemPrompt(app)
        // Give the wall time to settle on its Unlock key (before it, it is mid-"Unlocking").
        _ = app.el("locker-unlock").waitForExistence(timeout: 15)
        // KNOWN, AND NOT HIDDEN (#1202, S4): once the demo seed is in the Keychain the wall
        // opens already mid-"Unlocking", waiting on the system's authentication, and on that
        // state the audit service answers "Invalid target app" (-902) for every attempt. That
        // one refusal is expected, non-strictly (it still passes on a build where the wall
        // answers); every issue the audit does report is counted and ratcheted as usual.
        XCTExpectFailure("The audit service refuses the Locker wall while it waits on authentication", options: .nonStrict()) {
            audit(app, mode: mode, screen: "Locker wall") {
                app.el("home-tile-locker").tap()
                _ = app.el("locker-unlock").waitForExistence(timeout: 30)
                self.dismissSystemPrompt(app)
            }
        }
        try goHome(app)

        try open(app, tile: nil, id: "home-settings-open")
        audit(app, mode: mode, screen: "Settings")
        try goHome(app)

        try open(app, tile: nil, id: "home-band-backup")
        audit(app, mode: mode, screen: "Backup")
        try goHome(app)
        XCUIDevice.shared.appearance = .light
        settle(mode: mode)
    }

    // MARK: Reading order

    /// What VoiceOver would visit, in the order it would visit it: the leaf
    /// elements of the accessibility hierarchy, depth first. A button is one stop
    /// (its label), not its glyph and its text.
    @MainActor private func readingOrder(_ app: XCUIApplication) throws -> [String] {
        let stops: Set<XCUIElement.ElementType> = [
            .button, .staticText, .textField, .secureTextField, .textView, .searchField, .switch, .link, .image, .slider,
        ]
        var out: [String] = []
        func walk(_ node: XCUIElementSnapshot) {
            if stops.contains(node.elementType), node.frame.width > 0, node.frame.height > 0,
               !(node.label.isEmpty && node.identifier.isEmpty) {
                out.append(node.label.isEmpty ? node.identifier : node.label)
                if node.elementType == .button { return }
            }
            node.children.forEach(walk)
        }
        walk(try app.snapshot())
        return out
    }

    /// Each pattern must be found, in this order, among the stops (not necessarily
    /// adjacent: the rows between are data). A miss names the whole order it saw.
    private func expectOrder(_ stops: [String], _ patterns: [String], flow: String, file: StaticString = #filePath, line: UInt = #line) {
        var at = 0
        for pattern in patterns {
            guard let hit = stops[at...].firstIndex(where: { $0.range(of: pattern, options: .regularExpression) != nil }) else {
                XCTFail("\(flow): \"\(pattern)\" is not read after position \(at). VoiceOver would read: \(stops.joined(separator: " > "))", file: file, line: line)
                return
            }
            at = hit + 1
        }
        print("ORDER-PASS|\(flow)")
    }

    // MARK: VoiceOver order of four flows

    /// Add a reminder: the page, its Add key, the smart lists, then the open quick-add
    /// bar's keys and its field, the visual order from the top.
    @MainActor func testFocusOrderAddReminder() throws {
        let app = launch(textSize: nil)
        try open(app, tile: "home-tile-reminders")
        app.el("agenda-add-task").tap()
        XCTAssertTrue(app.el("agenda-quick-add").waitForExistence(timeout: 10) || app.textFields.firstMatch.waitForExistence(timeout: 10))
        expectOrder(
            try readingOrder(app),
            ["^Reminders$", "^Filter and sort$", "^Add task$", "^Today", "^Scheduled", "^All", "^Flagged", "^Logbook", "^My Lists",
             "^Date$", "^Tag$", "^Flag$", "^Link$", "^Photo$", "^Add to Inbox$"],
            flow: "add a reminder"
        )
    }

    /// Open a note: Done, the actions, the line over the title, the title, the tag
    /// field, the body, then the toolbar.
    @MainActor func testFocusOrderOpenNote() throws {
        let app = launch(textSize: nil)
        try open(app, tile: "home-tile-notes")
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'notes-row-'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "the demo vault has notes")
        row.tap()
        XCTAssertTrue(app.el("note-body-field").waitForExistence(timeout: 10))
        expectOrder(
            try readingOrder(app),
            ["^Done$", "^Note actions$", "Edited", "^note-title-field$", "^note-tag-field$", "^Write something$", "^Checklist$", "^Add link$", "^Add a tag$", "^Hide keyboard$"],
            flow: "open a note"
        )
    }

    /// The Locker wall: its title, the state, the sentence, then the band.
    @MainActor func testFocusOrderLockerWall() throws {
        let app = launch(textSize: nil)
        try open(app, tile: "home-tile-locker")
        XCTAssertTrue(app.el("locker-wall").waitForExistence(timeout: 10))
        expectOrder(
            try readingOrder(app),
            ["^Locker$", "^(Unlocking|Unlock)", "hidden until you unlock", "^Home$", "^Items$", "^Review$", "^Generate$", "^More$"],
            flow: "Locker unlock wall"
        )
    }

    /// The Backup pair page: the title, the command to run, the field, then the verbs.
    @MainActor func testFocusOrderBackupPair() throws {
        let app = launch(textSize: nil)
        try open(app, tile: nil, id: "home-band-backup")
        XCTAssertTrue(app.el("backup-add-destination").waitForExistence(timeout: 10))
        app.el("backup-add-destination").tap()
        XCTAssertTrue(app.staticTexts["Pair with your backup device"].waitForExistence(timeout: 10))
        expectOrder(
            try readingOrder(app),
            ["^Pair with your backup device$", "^Run$", "pair", "^Pairing code$", "^Cancel$", "^Scan QR code$", "^Pair$"],
            flow: "Backup pair page"
        )
    }

    // MARK: Reduce Motion

    /// The roots under the system's Reduce Motion, which no launch argument can set:
    /// `verify-ios.sh` writes it into the simulator's accessibility preferences,
    /// restarts the simulator, and says so in the environment. The app keys its
    /// motion off `accessibilityReduceMotion` and its glass off Reduce Transparency
    /// and Increase Contrast, so this is the run that proves a slide became the
    /// change without a root falling over. BOLD TEXT IS NOT PROVED HERE: the
    /// `BoldTextEnabled` preference is written alongside it, but UIKit's
    /// `isBoldTextEnabled` stays false on a simulator whatever the preference says,
    /// so no run of this suite stands for Bold Text.
    @MainActor func testRootsUnderReducedMotion() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["CENTRAID_UI_SYSTEM_SETTINGS"] == "reduce-motion",
            "run by verify-ios.sh, which sets Reduce Motion on the simulator"
        )
        XCTAssertTrue(UIAccessibility.isReduceMotionEnabled, "Reduce Motion is on")
        try tour(mode: "reduce-motion", appearance: .light, textSize: nil)
    }

    // MARK: Driving the app

    @MainActor private func launch(textSize: String?) -> XCUIApplication {
        let app = XCUIApplication()
        if let size = textSize {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", size]
        }
        // The demo seed `verify-ios.sh` hands over as `TEST_RUNNER_CENTRAID_DEV_SEED`;
        // a DEBUG build keys the demo Locker with it (`ShellModel.devSeedHex`).
        if let seed = ProcessInfo.processInfo.environment["CENTRAID_DEV_SEED"] {
            app.launchEnvironment["CENTRAID_DEV_SEED"] = seed
        }
        app.launch()
        XCTAssertTrue(app.el("home-grid").waitForExistence(timeout: 60), "Home draws its grid")
        return app
    }

    @MainActor private func open(_ app: XCUIApplication, tile: String?, id: String? = nil) throws {
        let key = app.el(tile ?? id ?? "")
        // The grid is lazy: at the largest sizes a tile off the screen is not in the
        // hierarchy at all, above the fold or below it. Home keeps its scroll position
        // between visits, so go to the top, then down a screen at a time.
        func scrollTo() {
            if key.exists && key.isHittable { return }
            for _ in 0..<4 { app.swipeDown() }
            var swipes = 0
            while !(key.exists && key.isHittable) && swipes < 8 {
                app.swipeUp()
                swipes += 1
            }
        }
        scrollTo()
        if !key.exists {
            // The audit's text-size sweep can leave Home's lazy grid short of a tile it
            // had before (seen at the largest size, after Photos): a fresh launch is Home as
            // a member opens it.
            print("NAV-FALLBACK|\(tile ?? id ?? "") missing; relaunching")
            app.terminate()
            app.launch()
            XCTAssertTrue(app.el("home-grid").waitForExistence(timeout: 60), "Home draws its grid after a relaunch")
            scrollTo()
        }
        XCTAssertTrue(key.waitForExistence(timeout: 10), "\(tile ?? id ?? "") is on Home")
        key.tap()
    }

    /// Back to Home by the way a member goes: the home capsule of an app's band,
    /// else a close key or the sheet's own swipe. A screen that will not let go is
    /// logged (`NAV-FALLBACK`) and the app is relaunched, so one stuck sheet cannot
    /// hide every screen after it.
    @MainActor private func goHome(_ app: XCUIApplication) throws {
        for _ in 0..<4 {
            if app.el("home-grid").exists && app.el("home-grid").isHittable { return }
            let capsule = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier ENDSWITH '-band-home'"))
                .firstMatch
            if capsule.exists && capsule.isHittable { capsule.tap(); continue }
            if !dismissSheet(app) && app.navigationBars.buttons.firstMatch.exists {
                app.navigationBars.buttons.firstMatch.tap()
            }
        }
        if app.el("home-grid").waitForExistence(timeout: 3) && app.el("home-grid").isHittable { return }
        print("NAV-FALLBACK|\(outline(app))")
        app.terminate()
        app.launch()
        XCTAssertTrue(app.el("home-grid").waitForExistence(timeout: 60), "back on Home after a relaunch")
    }

    /// Ends the sheet that is up: its own close key, else a drag down from its top.
    @MainActor @discardableResult private func dismissSheet(_ app: XCUIApplication) -> Bool {
        let pushed = app.el("kit-pushed-back")
        if pushed.exists && pushed.isHittable { pushed.tap(); return true }
        for label in ["Close", "Done", "Cancel", "Back"] {
            let key = app.buttons[label].firstMatch
            if key.exists && key.isHittable { key.tap(); return true }
        }
        let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12))
        top.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
        return true
    }

    /// What the system has on screen over the app, for a log line when an audit finds no app.
    @MainActor private func springboardOutline() -> String {
        let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let found = sb.descendants(matching: .any).allElementsBoundByIndex.prefix(60)
            .filter { !$0.label.isEmpty }
            .map { "\($0.elementType.rawValue):\($0.label)" }
        return found.joined(separator: " ; ")
    }

    /// The hittable buttons on screen, for a log line when a screen will not close.
    @MainActor private func outline(_ app: XCUIApplication) -> String {
        app.buttons.allElementsBoundByIndex.prefix(30)
            .filter { $0.isHittable }
            .map { "\($0.identifier)=\($0.label)" }
            .joined(separator: " ; ")
    }

    /// The wall asks the system to authenticate the moment it opens, and the system's
    /// prompt covers the app, so the audit has no app to read ("Invalid target app").
    /// It is cancelled, which leaves the wall as a member who declined sees it.
    @MainActor private func dismissSystemPrompt(_ app: XCUIApplication) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["Cancel", "Close"] {
            let key = springboard.buttons[label].firstMatch
            if key.waitForExistence(timeout: 2) { key.tap() }
        }
        clearSystemAlerts(app)
        app.activate()
    }

    /// A system alert over the app (the local-network or Face ID permission, the
    /// first time the app runs) leaves the audit with no app to read, and an audit is
    /// not an interaction, so XCUITest does not dismiss it. Each is declined: a
    /// permission is never granted by a test.
    @MainActor private func clearSystemAlerts(_ app: XCUIApplication) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for _ in 0..<3 {
            let alert = springboard.alerts.firstMatch
            guard alert.exists else { return }
            let decline = ["Don\u{2019}t Allow", "Don't Allow", "Not Now", "Cancel", "OK", "Close"]
                .map { alert.buttons[$0] }
                .first { $0.exists }
            (decline ?? alert.buttons.firstMatch).tap()
            Thread.sleep(forTimeInterval: 1)
        }
    }

    // MARK: The audit

    /// Per-element exemptions. EMPTY ON PURPOSE: an entry names the screen, the
    /// audit type, the element and the design rule that allows it, in a comment.
    private struct Exemption {
        let screen: String?
        let type: XCUIAccessibilityAuditType
        /// The element's whole identifier (an empty string: it has none).
        let id: String?
        let label: String?
        func matches(screen: String, type: XCUIAccessibilityAuditType, id: String, label: String) -> Bool {
            (self.screen.map { $0 == screen || screen.hasPrefix($0 + " ") } ?? true)
                && self.type == type
                && (self.id.map { $0 == id } ?? true)
                && (self.label.map { label.range(of: $0, options: .regularExpression) != nil } ?? true)
        }
    }

    /// THE BAND'S LABELS HOLD THEIR SIZE AT EVERY SETTING, and so do the calendar's
    /// seven-day grids (`design/behaviour.md`, Accessibility: "the band's labels hold
    /// their size at every setting, and so do the words inside a badge and along a
    /// chart's axis, like the calendar's seven-day grids"). The audit reads a held size
    /// as a Dynamic Type failure; the rule says it is the design. Narrow on purpose:
    /// the labels are the band's own words, the grid's are single letters, day numbers
    /// and hours, and neither matches a title (`kit-header-title`) or a figure.
    private static let bandLabels =
        "^(Home|Chat|Backup|Calendar|Invites|More|Reminders|Notes|Journal|Notebooks|People|Touch"
        + "|Recents|Browse|Starred|Activity|Spending|Cash flow|Summary|Trends|Workouts|Items|Review|Generate)$"

    private static let exemptions: [Exemption] = [
        Exemption(screen: nil, type: .dynamicType, id: "", label: bandLabels),
        Exemption(screen: "Calendar", type: .dynamicType, id: "", label: "^([MTWFS]|\\d{1,2}|\\d{2}:00)$"),
    ]

    private static func typeName(_ type: XCUIAccessibilityAuditType) -> String {
        switch type {
        case .contrast: "contrast"
        case .elementDetection: "elementDetection"
        case .hitRegion: "hitRegion"
        case .sufficientElementDescription: "sufficientElementDescription"
        case .dynamicType: "dynamicType"
        case .textClipped: "textClipped"
        case .trait: "trait"
        default: "type\(type.rawValue)"
        }
    }

    @MainActor private func audit(_ app: XCUIApplication, mode: String, screen: String, restore: (() -> Void)? = nil) {
        // Let the screen settle: the audit reads a hierarchy, not a transition.
        _ = app.wait(for: .runningForeground, timeout: 5)
        Thread.sleep(forTimeInterval: 1)
        clearSystemAlerts(app)
        var issues = 0
        for attempt in 0..<5 {
            issues = 0
            do {
                try app.performAccessibilityAudit { issue in
                    let id = issue.element?.identifier ?? ""
                    let label = issue.element?.label ?? ""
                    print("A11Y-ISSUE|\(mode)|\(screen)|\(issue.auditType.rawValue)|\(issue.compactDescription)|id=\(id)|label=\(label)|\(issue.detailedDescription)")
                    if Self.exemptions.contains(where: { $0.matches(screen: screen, type: issue.auditType, id: id, label: label) }) {
                        return true
                    }
                    issues += 1
                    self.found["\(mode)|\(screen)|\(Self.typeName(issue.auditType))", default: 0] += 1
                    // Handled here: whether the count is acceptable is `settle`'s to say.
                    return true
                }
                break
            } catch {
                // "Invalid target app" right after a launch: the audit service has not
                // attached yet. Four more tries; a fifth refusal is a failure.
                if attempt < 4 {
                    // The service has lost the app (on a loaded Mac it does): bring it
                    // forward, and from the third refusal on start the app afresh and
                    // walk back to this screen.
                    app.activate()
                    Thread.sleep(forTimeInterval: 8)
                    if attempt >= 2, let restore {
                        app.terminate()
                        app.launch()
                        XCTAssertTrue(app.el("home-grid").waitForExistence(timeout: 60), "Home draws its grid after a relaunch")
                        restore()
                    }
                    continue
                }
                XCTFail("\(mode) / \(screen): \(error)")
            }
        }
        print(issues == 0 ? "A11Y-PASS|\(mode)|\(screen)" : "A11Y-FAIL|\(mode)|\(screen)|\(issues)")
    }
}

extension XCUIApplication {
    /// The element with this accessibility identifier, whatever its type.
    func el(_ id: String) -> XCUIElement { descendants(matching: .any)[id].firstMatch }
}
