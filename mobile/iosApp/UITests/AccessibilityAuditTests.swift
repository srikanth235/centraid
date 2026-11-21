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
        /// An element only the Add screen has, which proves it is up before it is audited.
        var addProof: String? = nil
    }

    private static let roots: [Root] = [
        Root(name: "Calendar", tile: "home-tile-calendar", more: "calendar-band-more", add: "agenda-new-event"),
        Root(name: "Reminders", tile: "home-tile-reminders", more: "reminders-band-more", add: "agenda-add-task"),
        Root(name: "Notes", tile: "home-tile-notes", more: "notes-band-more", add: "notes-new-note"),
        Root(name: "People", tile: "home-tile-people", more: "people-band-more", add: "people-add-person", addProof: "kit-editor-close"),
        Root(name: "Docs", tile: "home-tile-docs", more: "docs-band-more", add: "docs-add"),
        Root(name: "Money", tile: "home-tile-money", more: "money-band-more", add: "money-add"),
        Root(name: "Health", tile: "home-tile-health", more: "health-band-more", add: nil),
        Root(name: "Photos", tile: "home-tile-photos", more: nil, add: nil),
    ]

    @MainActor private func tour(mode: String, appearance: XCUIDevice.Appearance, textSize: String?) throws {
        XCUIDevice.shared.appearance = appearance
        let app = launch(textSize: textSize)
        // `CENTRAID_UI_ONLY` (comma-separated screen names) narrows a run to those roots, to iterate on one
        // screen; unset, the whole tour runs, which is what the gate does.
        let only = ProcessInfo.processInfo.environment["CENTRAID_UI_ONLY"].flatMap { $0.isEmpty ? nil : $0 }.map { Set($0.split(separator: ",").map(String.init)) }
        if only == nil { audit(app, mode: mode, screen: "Home") {} }

        for root in Self.roots where only?.contains(root.name) ?? true {
            try open(app, tile: root.tile)
            // A TAP THAT OPENED NOTHING must not file Home's issues under this screen's name.
            let grid = app.el("home-grid")
            let end = Date().addingTimeInterval(15)
            while grid.exists && grid.isHittable && Date() < end { Thread.sleep(forTimeInterval: 0.3) }
            guard !(grid.exists && grid.isHittable) else {
                XCTFail("\(mode) / \(root.name): the page did not open (Home is still showing)")
                continue
            }
            audit(app, mode: mode, screen: root.name)
            if let more = root.more, app.el(more).exists {
                app.el(more).tap()
                audit(app, mode: mode, screen: "\(root.name) More")
                dismissSheet(app)
            }
            if let add = root.add, app.el(add).exists {
                app.el(add).tap()
                // AN ADD THAT OPENED NOTHING must not file the page's issues under "Add" (People Add once
                // audited the roster, 23 issues of a screen that was not up: the editor opens through the core).
                // Waits are bounded: one retap, then a failure that names the screen.
                var up = true
                if let proof = root.addProof, !app.el(proof).waitForExistence(timeout: 10) {
                    if app.el(add).exists && app.el(add).isHittable { app.el(add).tap() }
                    up = app.el(proof).waitForExistence(timeout: 20)
                    if !up { XCTFail("\(mode) / \(root.name): Add did not open its screen (\(proof) is not there)") }
                }
                if up { audit(app, mode: mode, screen: "\(root.name) Add") }
                dismissSheet(app)
            }
            try goHome(app)
        }

        if only != nil { XCUIDevice.shared.appearance = .light; settle(mode: mode); return }
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
        // THE WALL AUDITED ONLY WHEN SETTLED (#1202): a simulator has no owner check to answer, so
        // the wall opens "Unlocking" and waits on it, and the audit service refuses an app in that
        // state (-902). A member who leaves the app under that prompt comes back to the locked wall
        // (the prompt is cancelled by the system), which is what is audited.
        settleLockerWall(app)
        XCTAssertTrue(app.el("locker-unlock").exists, "the Locker wall is settled (locked) before it is audited")
        audit(app, mode: mode, screen: "Locker wall") {
            self.openLockerWall(app)
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

    /// Brings the wall out of "Unlocking" to its settled state: send the app to the Home Screen and
    /// back, which the system answers by cancelling the owner check, and wait for the Unlock key.
    @MainActor private func settleLockerWall(_ app: XCUIApplication) {
        dismissSystemPrompt(app)
        if app.el("locker-unlock").waitForExistence(timeout: 5) { return }
        for _ in 0..<3 {
            XCUIDevice.shared.press(.home)
            Thread.sleep(forTimeInterval: 2)
            app.activate()
            if app.el("locker-unlock").waitForExistence(timeout: 10) { return }
        }
    }

    /// Back on the Locker wall from Home (a relaunch of the audit), settled.
    @MainActor private func openLockerWall(_ app: XCUIApplication) {
        app.el("home-tile-locker").tap()
        _ = app.el("locker-wall").waitForExistence(timeout: 30)
        settleLockerWall(app)
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

    /// THE QUICK-ADD BAR SURVIVES A TEXT-SIZE SWEEP (#1202). With the bar open the keyboard leaves
    /// the page a few hundred points, and a change of text size under it (the audit's sweep, or a
    /// member's turn of the slider) brought the app down: the Reminders home's smart-list tiles were a
    /// `LazyVGrid` in a row of the page's `List`, and UIKit trapped in `_updateVisibleCellsNow` while
    /// the two sized each other. `performAccessibilityAudit(for: .dynamicType)` walks every text size.
    @MainActor func testQuickAddBarSurvivesTextSizeSweep() throws {
        let app = launch(textSize: nil)
        try open(app, tile: "home-tile-reminders")
        app.el("agenda-add-task").tap()
        XCTAssertTrue(app.el("agenda-quick-add").waitForExistence(timeout: 10) || app.textFields.firstMatch.waitForExistence(timeout: 10))
        try app.performAccessibilityAudit(for: .dynamicType) { _ in true }
        XCTAssertEqual(app.state, .runningForeground, "the app is still up after the sweep")
        XCTAssertTrue(app.el("agenda-todo-list").exists || app.textFields.firstMatch.exists, "and still on the page")
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
        // A TILE UNDER THE FLOATING BAND IS "HITTABLE" AND A TAP ON IT LANDS ON THE BAND (at the largest
        // sizes the Locker tile stops there and the tap opened Chat): bring it above the band.
        var nudges = 0
        while key.exists, key.frame.midY > app.frame.height - 150, nudges < 4 {
            let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
            from.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)))
            nudges += 1
        }
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
        // A tile the grid reports as hittable can lie wholly above the screen or under the band (at
        // the largest sizes a tile is taller than the screen): scroll until a strip of it is clear of the
        // header and the band, and press there.
        let top: CGFloat = 130, bottom: CGFloat = app.frame.maxY - 120
        func clear() -> (CGFloat, CGFloat)? {
            let f = key.frame
            let lo = max(f.minY, top), hi = min(f.maxY, bottom)
            return hi - lo >= 30 ? (lo, hi) : nil
        }
        func press() {
            if tile == nil { key.tap(); return }
            for _ in 0..<8 where clear() == nil {
                if key.frame.minY >= bottom { app.swipeUp() } else { app.swipeDown() }
            }
            let f = key.frame
            let (lo, hi) = clear() ?? (max(f.minY, top), min(f.maxY, bottom))
            let point = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: f.midX, dy: (lo + min(hi, lo + 60)) / 2))
            point.tap()
        }
        press()
        // At the largest sizes a tap can land while the grid is still settling and open nothing:
        // an audit of "the app" would then read Home under another screen's name.
        let grid = app.el("home-grid")
        for _ in 0..<3 {
            let end = Date().addingTimeInterval(6)
            while grid.exists && grid.isHittable && Date() < end { Thread.sleep(forTimeInterval: 0.3) }
            if !(grid.exists && grid.isHittable) { return }
            if key.exists && key.isHittable { press() }
        }
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
    private struct Exemption: Sendable {
        let screen: String?
        let type: XCUIAccessibilityAuditType
        /// The element's whole identifier (an empty string: it has none).
        let id: String?
        let label: String?
        /// Further condition on the element's frame and the screen's (points).
        var frame: (@Sendable (CGRect, CGRect) -> Bool)? = nil
        /// Match the screen's name exactly, not its sheets (`Money`, not `Money More`).
        var exactScreen = false
        /// Only an element that reaches down into the quick-add bar (its keys' top, when it is open).
        var underBar = false
        /// Only an element under the floating band (its frame reaches into the strip the band's glass covers).
        var underBand = false
        /// Only an element that starts above the foot of the Calendar's all-day lane (its fade included, 32pt): the hour grid scrolls
        /// under that lane's wash, so what sits there is covered, not shown.
        var underLane = false
        /// The element's identifier starts with this (a family of ids that end in a key).
        var idPrefix: String? = nil
        /// The element's identifier matches this expression (a few ids of one kind).
        var idRegex: String? = nil
        /// The audit's own description of the element (its class, for a system view).
        var detail: String? = nil
        func matches(screen: String, type: XCUIAccessibilityAuditType, id: String, label: String, frame: CGRect, in screenFrame: CGRect, barTop: CGFloat?, underBand under: Bool, laneBottom: CGFloat?, detail text: String) -> Bool {
            (!underBand || under)
                && (self.detail.map { text.range(of: $0, options: .regularExpression) != nil } ?? true)
                && (self.screen.map { exactScreen ? $0 == screen : ($0 == screen || screen.hasPrefix($0 + " ")) } ?? true)
                && self.type == type
                && (self.id.map { $0 == id } ?? true)
                && (idPrefix.map { id.hasPrefix($0) } ?? true)
                && (idRegex.map { id.range(of: $0, options: .regularExpression) != nil } ?? true)
                && (!underLane || (laneBottom.map { frame.minY < $0 + 32 } ?? false))
                && (self.label.map { label.range(of: $0, options: .regularExpression) != nil } ?? true)
                && (self.frame.map { $0(frame, screenFrame) } ?? true)
                && (!underBar || (barTop.map { frame.maxY > $0 } ?? false))
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
        + "|Calendars|Recents|Browse|Starred|Activity|Spending|Cash flow|Summary|Trends|Workouts|Items|Review|Generate)$"

    private static let exemptions: [Exemption] = [
        Exemption(screen: nil, type: .dynamicType, id: "", label: bandLabels),
        // CALENDAR: the seven-day strip's initials and numbers, the hour marks and the now pill's clock
        // are the grid's held words (behaviour.md, Accessibility: "like the calendar's seven-day grids"), in the
        // 24-hour ("16:09") and 12-hour ("4:04 PM") clocks alike.
        Exemption(screen: "Calendar", type: .dynamicType, id: "", label: "^([MTWFS]|\\d{1,2}|\\d{1,2}:\\d{2}(\\s?[AP]M)?)$"),
        // HOME / CALENDAR, UNDER THE BAND: the page scrolls beneath the floating band's glass (behaviour.md,
        // Rooms: "the page scrolls under its glass"), and the audit samples the blurred pixels of whatever
        // passes under it, so text there reads as low contrast (seen on a Home tile and a Day block whose
        // words are 7:1 and more when scrolled clear of the band).
        Exemption(screen: "Home", type: .contrast, id: nil, label: nil, underBand: true),
        Exemption(screen: "Calendar", type: .contrast, id: nil, label: nil, underBand: true),
        Exemption(screen: "Backup", type: .contrast, id: nil, label: nil, underBand: true),
        // CALENDAR, THE WEEK STRIP'S INITIALS: `text` ink (14:1) on the page; the audit passes M and W and
        // fails the thinnest glyphs (T, F, S) of the same face, colour and size, whose 8-pixel stems it
        // reads at a blended grey. They are one-letter labels of a button that says the whole day.
        Exemption(screen: "Calendar", type: .contrast, id: "", label: "^[MTWFS]$"),
        // CALENDAR ADD, JOINING LINK: the field's frame is 201 x 54 pt, over the 44 floor both ways, so the hit read
        // is not about its size (the one-line field it replaced was 22 pt tall and was not flagged).
        Exemption(screen: "Calendar Add", type: .hitRegion, id: "agenda-editor-link", label: nil),
        // CALENDAR ADD, THE "Title" KEY: `text` ink, 14:1 on the page, in the semibold face; it sits just under the
        // bar's blurred scroll edge, which the audit samples with it.
        Exemption(screen: "Calendar Add", type: .contrast, id: "", label: "^Title$"),
        // LOCKER WALL: the title is the system bar's own top row (`RootBarTitle`, a toolbar item), which the bar
        // sizes itself (the frame grew 108 -> 121 pt from the default to the largest size, while the same face in
        // the page grows 1.7x); and the band's labels pass under the glass at the largest size ("under the band").
        Exemption(screen: "Locker wall", type: .dynamicType, id: "kit-header-title", label: nil),
        Exemption(screen: "Locker wall", type: .contrast, id: nil, label: nil, underBand: true),
        // CALENDAR MORE: the sheet is the system's glass, and the page's words (the hour labels, the band's
        // labels) show blurred through it; the audit reads each smear as text with no element. Nothing is
        // there to label: the screenshot shows only blur.
        Exemption(screen: "Calendar More", type: .elementDetection, id: nil, label: nil),
        // CALENDAR ADD, SAVE: the key is off until the event has a title, and an inactive control is outside
        // the contrast rule (WCAG 1.4.3); the bar draws it dimmed. Its Dynamic Type read is the bar item's:
        // the system bar sizes its own items.
        Exemption(screen: "Calendar Add", type: .contrast, id: "agenda-editor-save", label: nil),
        Exemption(screen: "Calendar Add", type: .dynamicType, id: "agenda-editor-save", label: nil),
        // CALENDAR, THE MONTH CHIP: a bar item too (the Day and Week bar's leading key, "November"; its frame grew
        // 96 -> 111 pt across the whole range).
        Exemption(screen: "Calendar", type: .dynamicType, id: "", label: "^(January|February|March|April|May|June|July|August|September|October|November|December)$"),
        // CALENDAR, A BLOCK'S TITLE AND TIME: the hour grid holds at `xxxLarge` by design (behaviour.md,
        // Accessibility: "like the calendar's seven-day grids"; AgendaCalendarViews: "THE HOUR GRID HOLDS"),
        // and a block's words are inside it, so the audit reads them as partly scaling. They do grow to
        // `xxxLarge`: s4-proof/calendar-block-default.png and calendar-block-xxxl.png.
        Exemption(screen: "Calendar", type: .dynamicType, id: "agenda-grid-block-title", label: nil),
        Exemption(screen: "Calendar", type: .dynamicType, id: "agenda-grid-block-detail", label: nil),
        // CALENDAR, THE HOUR GRID UNDER THE ALL-DAY LANE: the grid scrolls beneath the lane's chips, which are
        // drawn over it, so a block's title or time that sits there is covered (its ink is read against the
        // chips' wash). The same words pass once scrolled into the grid: s4-proof/calendar-lane-covers-grid.png.
        Exemption(screen: "Calendar", type: .contrast, id: "agenda-grid-block-title", label: nil, underLane: true),
        Exemption(screen: "Calendar", type: .contrast, id: "agenda-grid-block-detail", label: nil, underLane: true),
        // CALENDAR, THE FOOT GRIP OF A MOVABLE BLOCK: a drag on the foot moves the block's end, over a 16pt
        // strip of the block's own foot. It is not a control to aim at: the block is the target, and VoiceOver
        // adjusts the end through the grip's adjustable action (`agenda-grid-block-resize-*`, "Change end time").
        Exemption(screen: "Calendar", type: .hitRegion, id: nil, label: "^Change end time$", idPrefix: "agenda-grid-block-resize-"),
        // CALENDAR, TEXT PEEKING FROM UNDER THE BAND: the hour grid runs under the band's glass, and a label cut
        // by it (the "18:00" mark half-drawn at the foot) is text the audit finds with no element.
        // Proof: s4-proof/calendar-lane-covers-grid.png, foot of the page.
        Exemption(screen: "Calendar", type: .elementDetection, id: "", label: "^$", frame: { f, _ in f == .zero }, underBand: true),
        // SYSTEM KEYBOARD: the QuickType suggestion cells are the keyboard's own views (`TUIPredictionViewCell`),
        // not ours; they have no label to give. Proof: s4-proof/reminders-add-keyboard.png.
        Exemption(screen: "Reminders Add", type: .sufficientElementDescription, id: "", label: "^$", detail: "TUIPredictionViewCell"),
        // HOME, THE EYEBROW: the 11pt weekday over the date is the caption2 face, which the system holds at the
        // same point size across its first four text sizes (11, 11, 11, 11, then 15), so a step-by-step
        // comparison reads it as partly fixed.
        Exemption(screen: "Home", type: .dynamicType, id: "", label: "^(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)$"),
    ] + docsNotesHealthExemptions + moneyPeopleExemptions + sheetExemptions + underBandExemptions

    /// DOCS, NOTES AND HEALTH (#1202, S4 a11y-2): per element, each with its reason, each proved by
    /// taking the cause away in a throwaway run.
    private static let docsNotesHealthExemptions: [Exemption] = [
        // The page title is the navigation bar's own toolbar item (`RootBarTitle`): UIKit hosts it on
        // one line and holds its size, so the audit reads it as only partly scaling.
        Exemption(screen: "Docs", type: .dynamicType, id: "kit-header-title", label: nil),
        Exemption(screen: "Notes", type: .dynamicType, id: "kit-header-title", label: nil),
        Exemption(screen: "Health", type: .dynamicType, id: "kit-header-title", label: nil),
        // The editor's Cancel is a toolbar item too (`kit-editor-close`), held by the bar the same way.
        Exemption(screen: "Notes Add", type: .dynamicType, id: "kit-editor-close", label: nil),
        // A kind badge's words hold at `xxxLarge` (design/behaviour.md, Accessibility: "the words
        // inside a badge ... hold"), so the audit reads them as only partly scaling.
        Exemption(screen: "Docs", type: .dynamicType, id: "docs-tile-badge", label: nil),
        // A Docs tile's title, meta and count: the grid reflows from three across to two to one as the
        // text grows ("Cards reflow at large text sizes"), and the audit reads a text that moves to a
        // wider column as not scaling. Held at three across the audit finds nothing.
        Exemption(screen: "Docs", type: .dynamicType, id: "docs-tile-text", label: nil),
        // A note's preview is the first lines of its body, line-clamped by design ("Text in a
        // fixed-height container is line-clamped"); the full text is the note.
        Exemption(screen: "Notes", type: .textClipped, id: "notes-row-preview", label: nil),
        // The band's own labels on its glass: the audit measures ink against what shows through the
        // glass, and with the band drawn solid it finds none (the same labels the dynamic-type
        // exemption above names).
        Exemption(screen: "Docs", type: .contrast, id: "", label: bandLabels),
        Exemption(screen: "Notes", type: .contrast, id: "", label: bandLabels),
        Exemption(screen: "Health", type: .contrast, id: "", label: bandLabels),
    ]

    /// MONEY, PEOPLE, PHOTOS, REMINDERS (#1202, S4 a11y-3).
    private static let moneyPeopleExemptions: [Exemption] = [
        // MONEY, PEOPLE, PHOTOS, REMINDERS: A PAGE SCROLLS UNDER THE BAND'S GLASS (the design: a floating
        // band over the page), and the audit reads the glass and the blur as the text's ground. These
        // are the elements that reach into the band's zone (the bottom 120 pt) or lie below the screen. Every
        // other element of the page is audited, and the same rows pass when scrolled clear of the band.
        // REMINDERS ADD: the quick-add bar and its keys sit over the foot of the page (the page is
        // clipped at the bar), so whatever the page has down there ("My Lists", the lower tiles at the
        // largest sizes) is in the hierarchy and under the bar's plate, not on screen as drawn.
        Exemption(screen: "Reminders Add", type: .contrast, id: nil, label: nil, exactScreen: true, underBar: true),
        // PEOPLE AND REMINDERS: ROWS OF A LAZY LIST. The roster (a `LazyVStack`) and the Reminders page
        // (a `List`) recycle their rows, and the audit's text-size sweep loses a recycled row as the
        // text grows and reports its text as "partially unsupported". The same roster drawn eagerly
        // (a `VStack`, tried for this change) reports none of its rows, and its text is the kit's
        // scaling type. The rows below the header are matched by position; the band and the header
        // are audited. NEEDS THE OWNER'S RULING: an eager roster would clear these and costs the
        // laziness a long contact list wants.
        Exemption(screen: "Reminders", type: .dynamicType, id: nil, label: "^(My Lists|Add List)$", exactScreen: true),
        // PEOPLE: the state badge's word holds its size (behaviour.md: the words inside a badge hold).
        Exemption(screen: "People", type: .dynamicType, id: "", label: "^[A-Z][A-Z ]{2,}$", exactScreen: true),
        // TITLES AND KEYS IN THE NAVIGATION BAR. Every text the app puts in a toolbar item (a root's
        // title, an editor's Cancel and its Saved) is reported "partially unsupported", and no text
        // outside a toolbar item on these screens is once its row is not recycled: the bar is UIKit's
        // and lays its items out on its own schedule, which the sweep outruns. The title and the keys
        // do scale (see the xxxL boards).
        Exemption(screen: "Money", type: .dynamicType, id: "kit-header-title", label: nil, exactScreen: true),
        Exemption(screen: "People", type: .dynamicType, id: "kit-header-title", label: nil, exactScreen: true),
        Exemption(screen: "Photos", type: .dynamicType, id: "kit-header-title", label: nil, exactScreen: true),
        Exemption(screen: "Reminders", type: .dynamicType, id: "kit-header-title", label: nil),
        Exemption(screen: "People Add", type: .dynamicType, id: "kit-editor-close", label: nil),
        Exemption(screen: "People Add", type: .dynamicType, id: "kit-autosave-status", label: nil),
        // MONEY, PEOPLE, PHOTOS, REMINDERS: THE BAND'S LABELS sit on Liquid Glass over whatever the page
        // has scrolled under them, and the audit reads that content as their ground, so the same label
        // fails over a bright card and passes over the plain page (Reminders and Photos pass).
        Exemption(screen: "Money", type: .contrast, id: "", label: bandLabels, exactScreen: true),
        Exemption(screen: "People", type: .contrast, id: "", label: bandLabels, exactScreen: true),
        Exemption(screen: "Photos", type: .contrast, id: "", label: bandLabels, exactScreen: true),
        Exemption(screen: "Reminders", type: .contrast, id: "", label: bandLabels, exactScreen: true),
        // THE MORE SHEETS (Money, People, Reminders): TWO FALSE POSITIVES OF A SHEET OVER A PAGE.
        // 1. The sheet's ground is the system's Liquid Glass on iOS 26 (owner ruling #1173: no slab of
        //    ours), so the ground the audit samples under a row is the blurred page behind the sheet
        //    (bright cards on Money, People's avatars): the same ink on the same sheet passes over a
        //    plain page (Docs, Notes) and is plainly legible in the screenshots.
        // 2. "Potentially inaccessible text" with an EMPTY label, id and ZERO frame: the page under
        //    the sheet is still painted but a modal presentation takes it out of accessibility, and
        //    the audit finds its words without an element. There is one such per word on the page
        //    behind; the sheet's own words are all elements.
        Exemption(screen: "Money More", type: .elementDetection, id: "", label: "^$", frame: { f, _ in f == .zero }, exactScreen: true),
        Exemption(screen: "People More", type: .elementDetection, id: "", label: "^$", frame: { f, _ in f == .zero }, exactScreen: true),
        Exemption(screen: "Reminders More", type: .elementDetection, id: "", label: "^$", frame: { f, _ in f == .zero }, exactScreen: true),
        // PEOPLE ADD: the first field's label sits in the top bar's scroll-edge fade (the card's top
        // edge is drawn under it, see the card's corner on the light board), so the audit samples the
        // fade's blend and not the card.
        Exemption(screen: "People Add", type: .contrast, id: "", label: "^Name$", frame: { f, _ in f.minY < 160 }),
        // PHOTOS: a video's length is white text drawn on the picture itself (a bright green clip
        // in the demo vault); its ground is the member's photograph, not a surface of ours.
        Exemption(screen: "Photos", type: .contrast, id: "", label: "^\\d{1,2}:\\d{2}(:\\d{2})?$"),
    ]


    /// THE MORE AND ADD SHEETS (owner ruling 26, 20 November): the sheets stay compact Liquid Glass and turn
    /// opaque under Reduce Transparency or Increase Contrast. A flag that remains is excused one ELEMENT at a
    /// time, by its words and the audit type, and each is proved whole and legible by a screenshot of the
    /// sheet (`s4-proof/`, named in the entry): over the glass the audit samples the blurred page behind the
    /// sheet as the ground (contrast), reads the row's frame as clipped when the sweep grows the text under a
    /// sheet that is still one fitting height (textClipped; at the accessibility sizes the sheet scrolls and
    /// the same words are whole, `accessibility-xxxl-*` boards), and finds the page's words behind the sheet
    /// with no element (elementDetection, frame zero). No whole screen is excused.
    private static let sheetExemptions: [Exemption] = [
        // CALENDAR MORE. Proof: light-Calendar-More.png, dark-Calendar-More.png, accessibility-xxxl-Calendar-More.png.
        Exemption(screen: "Calendar More", type: .contrast, id: nil, label: "^(Calendar|Calendars|Family|New Calendar|What Calendar may read|Work)$", exactScreen: true),
        Exemption(screen: "Calendar More", type: .textClipped, id: nil, label: "^(Calendar|Family|New Calendar|What Calendar may read|Work)$", exactScreen: true),
        // REMINDERS MORE. Proof: light-Reminders-More.png, dark-Reminders-More.png, accessibility-xxxl-Reminders-More.png.
        Exemption(screen: "Reminders More", type: .contrast, id: nil, label: "^(30 days, then erased|Anytime|Export|Turn on Phone reminders|What Reminders may read|done and won't do|no date, still yours|open work with a reminder)$", exactScreen: true),
        Exemption(screen: "Reminders More", type: .textClipped, id: nil, label: "^(30 days, then erased|Anytime|Export|Turn on Phone reminders|What Reminders may read|done and won't do|no date, still yours|open work with a reminder)$", exactScreen: true),
        // NOTES MORE. Proof: light-Notes-More.png, dark-Notes-More.png, accessibility-xxxl-Notes-More.png.
        Exemption(screen: "Notes More", type: .contrast, id: nil, label: "^(30 days, then erased|Export|Import|What Notes may read)$", exactScreen: true),
        Exemption(screen: "Notes More", type: .textClipped, id: nil, label: "^(30 days, then erased|Export|Import|What Notes may read)$", exactScreen: true),
        // PEOPLE MORE. Proof: light-People-More.png, dark-People-More.png, accessibility-xxxl-People-More.png.
        Exemption(screen: "People More", type: .contrast, id: nil, label: "^(30 days, then erased|Export|Import|Lists|Phone contacts|What People may read)$", exactScreen: true),
        Exemption(screen: "People More", type: .textClipped, id: nil, label: "^(30 days, then erased|Export|Import|Lists|Phone contacts|What People may read)$", exactScreen: true),
        // DOCS MORE. Proof: light-Docs-More.png, dark-Docs-More.png, accessibility-xxxl-Docs-More.png.
        Exemption(screen: "Docs More", type: .contrast, id: nil, label: "^(30 days, then erased|Recently added|What Docs may read|Your originals as one archive)$", exactScreen: true),
        Exemption(screen: "Docs More", type: .elementDetection, id: "", label: "^$", frame: { f, _ in f == .zero }, exactScreen: true),
        Exemption(screen: "Docs More", type: .textClipped, id: nil, label: "^(30 days, then erased|Recently added|What Docs may read|Your originals as one archive)$", exactScreen: true),
        // DOCS ADD. Proof: light-Docs-Add.png, dark-Docs-Add.png, accessibility-xxxl-Docs-Add.png.
        Exemption(screen: "Docs Add", type: .contrast, id: nil, label: "^(Add to Docs|Follow a folder|New folder|New text document|Scan a document|Upload a file)$", exactScreen: true),
        Exemption(screen: "Docs Add", type: .elementDetection, id: "", label: "^$", frame: { f, _ in f == .zero }, exactScreen: true),
        Exemption(screen: "Docs Add", type: .textClipped, id: nil, label: "^(Add to Docs|Follow a folder|New folder|New text document|Scan a document|Upload a file)$", exactScreen: true),
        // HEALTH MORE. Proof: light-Health-More.png, dark-Health-More.png, accessibility-xxxl-Health-More.png.
        Exemption(screen: "Health More", type: .contrast, id: nil, label: "^(30 days, then erased|Choose what to read|Daily totals and workouts as a spreadsheet|Stop reading Apple Health|What Health may read)$", exactScreen: true),
        Exemption(screen: "Health More", type: .textClipped, id: nil, label: "^(30 days, then erased|Choose what to read|Daily totals and workouts as a spreadsheet|Stop reading Apple Health|What Health may read)$", exactScreen: true),
        Exemption(screen: "Health More", type: .elementDetection, id: "", label: "^$", frame: { f, _ in f == .zero }, exactScreen: true),
        // MONEY MORE. Proof: light-Money-More.png, dark-Money-More.png, accessibility-xxxl-Money-More.png.
        Exemption(screen: "Money More", type: .contrast, id: nil, label: "^(30 days, then erased|Balances and statement checks|CSV, OFX or QFX|Groups and categories|Import statement|Name and file rows|Transactions as a spreadsheet|What Money may read)$", exactScreen: true),
        Exemption(screen: "Money More", type: .textClipped, id: nil, label: "^(30 days, then erased|Balances and statement checks|CSV, OFX or QFX|Groups and categories|Import statement|Name and file rows|Transactions as a spreadsheet|What Money may read)$", exactScreen: true),
    ]

    /// WHAT SCROLLS UNDER THE BAND, BY ELEMENT (#1202). The band floats over the page as glass and the page
    /// scrolls beneath it, so the last rows of a page sit under the glass and the audit reads the glass and
    /// the blur as their ground. Each entry names the element (the words it carries, or its id), the screen it
    /// is on and that it lies under the band (`underBand`); every other element of the page is audited, and
    /// the same words pass once scrolled clear of the band. Proof for all of them: the page's screenshots
    /// (`light-<Screen>.png`, `accessibility-xxxl-<Screen>.png`), which show the words whole at the page's
    /// foot beneath the band's glass.
    private static let underBandExemptions: [Exemption] = [
        // HOME's none. NOTES: a note row's meta line and its two-line preview, at the page's foot.
        Exemption(screen: "Notes", type: .contrast, id: "", label: "^(Edited .* · .*|Jake's lease ends in March.*)$", exactScreen: true, underBand: true),
        Exemption(screen: "Notes", type: .contrast, id: "notes-row-preview", label: nil, exactScreen: true, underBand: true),
        // REMINDERS: the "Completed" smart list's title, at the foot at the largest size.
        Exemption(screen: "Reminders", type: .contrast, id: "", label: "^Completed$", exactScreen: true, underBand: true),
        // PHOTOS AT THE LARGEST SIZE: once, the same "Completed" tile (same frame, at the foot) was read on the Photos
        // screen's name while the page was drawn over the previous one: it is the Reminders tile's word, still in the
        // hierarchy under the band. Proof: accessibility-xxxl-Photos.png shows the Photos page with no such word.
        Exemption(screen: "Photos", type: .contrast, id: "", label: "^Completed$", exactScreen: true, underBand: true),
        // PEOPLE: a roster row's name, role line, initials, at the foot.
        Exemption(screen: "People", type: .contrast, id: nil, label: nil, exactScreen: true, underBand: true, idRegex: "^people-(row-name|row-meta|avatar-initials|section-letter)$"),
        // DOCS: a tile's badge and title, at the foot at the largest size.
        Exemption(screen: "Docs", type: .contrast, id: nil, label: nil, exactScreen: true, underBand: true, idRegex: "^docs-tile-(badge|text)$"),
        // MONEY: the Net card's label and value, a transaction's date head, initial, payee, category and amount.
        Exemption(screen: "Money", type: .contrast, id: "", label: "^(Net|[+-]?\\$[0-9,.]+|(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]* [0-9]{1,2} [A-Z][a-z]+|[A-Z]|[A-Z0-9 ]{6,}|[A-Z][a-z]+( out)? · [A-Za-z ]+)$", exactScreen: true, underBand: true),
        // HEALTH: the Sleep card's title at the foot.
        Exemption(screen: "Health", type: .contrast, id: "", label: "^Sleep$", exactScreen: true, underBand: true),
        // PHOTOS: a day's date head at the foot.
        Exemption(screen: "Photos", type: .contrast, id: "", label: "^[A-Z][a-z]{2}, [A-Z][a-z]{2} [0-9]{1,2}$", exactScreen: true, underBand: true),
        // REMINDERS ADD: the page's words behind the quick-add bar's plate (no element: the audit finds them in the pixels).
        Exemption(screen: "Reminders Add", type: .contrast, id: "", label: "^$", frame: { f, _ in f == .zero }, exactScreen: true),
        // PEOPLE, THE ROSTER'S RECYCLED ROWS: the roster is a `LazyVStack` and the audit's text-size sweep loses a row
        // it has scrolled away from. The rows do scale: accessibility-xxxl-People.png shows a roster row at the
        // largest size, name and role whole, and the same rows in light-People.png.
        Exemption(screen: "People", type: .dynamicType, id: nil, label: nil, exactScreen: true, idRegex: "^people-(row-name|row-meta|avatar-initials|section-letter)$"),
        Exemption(screen: "People", type: .textClipped, id: nil, label: nil, exactScreen: true, idRegex: "^people-(row-name|row-meta)$"),
        // DOCS: the words inside a document's own thumbnail (a picture of the document), found with no element.
        // Proof: light-Docs.png, the tiles' pictures.
        Exemption(screen: "Docs", type: .elementDetection, id: "", label: "^$", frame: { f, _ in f == .zero }, exactScreen: true),
        Exemption(screen: "Docs", type: .dynamicType, id: "", label: "^$", frame: { f, _ in f == .zero }, exactScreen: true),
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
        // PROOF ON REQUEST: `CENTRAID_UI_PROOF_DIR` (a directory) takes a screenshot of each audited
        // screen, as the audit finds it, for the exemptions that cite one. Unset, nothing is written.
        if let dir = ProcessInfo.processInfo.environment["CENTRAID_UI_PROOF_DIR"] {
            let name = "\(mode)-\(screen)".replacingOccurrences(of: " ", with: "-")
            try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(dir)/\(name).png"))
        }
        var issues = 0
        for attempt in 0..<5 {
            issues = 0
            // BOUNDED BY CONSTRUCTION (#1202): every read of the app or of an issue's element is a query over
            // XCUITest's channel to the app (`app.frame` was read once per exemption, ~70 times an issue, so
            // a screen with 60 issues cost minutes). The frame and the two anchors are read ONCE per audit,
            // and an issue's element is read ONCE, as a snapshot.
            let appFrame = app.frame
            var barTop: CGFloat?
            if screen.hasPrefix("Reminders Add") { let bar = app.el("agenda-quick-tool-date"); barTop = bar.exists ? bar.frame.minY - 8 : nil }
            var laneBottom: CGFloat?
            if screen == "Calendar" { let lane = app.el("agenda-all-day-lane"); laneBottom = lane.exists ? lane.frame.maxY : nil }
            do {
                try app.performAccessibilityAudit { issue in
                    let snap = try? issue.element?.snapshot()
                    let id = snap?.identifier ?? ""
                    let label = snap?.label ?? ""
                    let frame = snap?.frame ?? .zero
                    print("A11Y-ISSUE|\(mode)|\(screen)|\(issue.auditType.rawValue)|\(issue.compactDescription)|id=\(id)|label=\(label)|type=\(snap?.elementType.rawValue ?? 0)|frame=\(frame)|\(issue.detailedDescription)")
                    let under = snap.map { $0.frame.height > 0 && $0.frame.maxY > appFrame.height - 96 } ?? true // no element: the audit could not place it, and the only unplaced contrast reads are of the blurred page under the band
                    if Self.exemptions.contains(where: { $0.matches(screen: screen, type: issue.auditType, id: id, label: label, frame: frame, in: appFrame, barTop: barTop, underBand: under, laneBottom: laneBottom, detail: issue.detailedDescription) }) {
                        return true
                    }
                    print("A11Y-OPEN|\(mode)|\(screen)|\(issue.auditType.rawValue)|id=\(id)|label=\(label)|frame=\(frame)|\(issue.detailedDescription)")
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
