import SwiftUI

/// THE PLATFORM'S DATE AND TIME PICKERS, BOUND TO CIVIL STRINGS (#1046 wave 5;
/// #1029 Tasks port).
///
/// A machine never reads a zone: it holds `YYYY-MM-DD` and `HH:MM` on the
/// device's wall clock, and a view's picker wants a `Date`. This is the one
/// conversion between the two — Gregorian, the device's current zone, no
/// rounding — so a picked value crosses back as exactly the civil string the
/// member saw. Nothing here decides a value: an unreadable string shows the
/// picker at `fallback` and sends nothing until the member picks.
enum CivilClock {
    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar
    }

    /// `2026-03-11` and `08:15` as one instant on this device's clock.
    static func date(day: String, time: String = "") -> Date? {
        let dayParts = day.split(separator: "-").compactMap { Int($0) }
        guard dayParts.count == 3 else { return nil }
        let timeParts = time.split(separator: ":").compactMap { Int($0) }
        var components = DateComponents()
        components.year = dayParts[0]
        components.month = dayParts[1]
        components.day = dayParts[2]
        components.hour = timeParts.count >= 2 ? timeParts[0] : 0
        components.minute = timeParts.count >= 2 ? timeParts[1] : 0
        return calendar.date(from: components)
    }

    static func day(_ date: Date) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    static func time(_ date: Date) -> String {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }
}

/// A compact date picker over a civil day. `onPick` gets `YYYY-MM-DD`.
struct CivilDayPicker: View {
    let label: String
    let day: String
    var fallbackDay: String = ""
    let onPick: (String) -> Void

    var body: some View {
        DatePicker(
            label,
            selection: Binding(
                get: { CivilClock.date(day: day) ?? CivilClock.date(day: fallbackDay) ?? Date() },
                set: { onPick(CivilClock.day($0)) }
            ),
            displayedComponents: .date
        )
        .labelsHidden()
        .accessibilityLabel(label)
    }
}

/// A compact time picker over a civil `HH:MM`. `onPick` gets `HH:MM`.
struct CivilTimePicker: View {
    let label: String
    let time: String
    let onPick: (String) -> Void

    var body: some View {
        DatePicker(
            label,
            selection: Binding(
                // An unset time shows the clock as it is, never an invented hour.
                get: { time.isEmpty ? Date() : (CivilClock.date(day: CivilClock.day(Date()), time: time) ?? Date()) },
                set: { onPick(CivilClock.time($0)) }
            ),
            displayedComponents: .hourAndMinute
        )
        .labelsHidden()
        .accessibilityLabel(label)
    }
}

/// ONE PICK IN FLIGHT: which picker, what it opens on, and where the pick goes.
/// `onPick` receives the day and the time; the unpicked half is passed back
/// as it was.
struct CivilPick: Identifiable {
    let id: String
    let title: String
    let time: Bool
    let day: String
    let clock: String
    let onPick: (String, String) -> Void
}

/// The platform's picker in a sheet — the calendar for a day, the wheel for a
/// time — titled with the machine's words. Every change is a pick; Done only
/// closes. The wheel's position is the sheet's own state, seeded once from
/// the draft, so a pick in flight never snaps it back.
struct CivilPickSheet: View {
    let pick: CivilPick
    let doneLabel: String
    let onDone: () -> Void

    @State private var selected: Date

    init(pick: CivilPick, doneLabel: String, onDone: @escaping () -> Void) {
        self.pick = pick
        self.doneLabel = doneLabel
        self.onDone = onDone
        let seed = pick.time
            ? (pick.clock.isEmpty ? Date() : (CivilClock.date(day: CivilClock.day(Date()), time: pick.clock) ?? Date()))
            : (CivilClock.date(day: pick.day) ?? Date())
        _selected = State(initialValue: seed)
    }

    var body: some View {
        SheetRoom(title: pick.title, primary: SheetPrimary(label: doneLabel, action: onDone)) {
            DatePicker(
                pick.title,
                selection: $selected,
                displayedComponents: pick.time ? .hourAndMinute : .date
            )
            .modifier(CivilPickStyle(time: pick.time))
            .labelsHidden()
            .frame(maxWidth: .infinity)
            .onChange(of: selected) { _, date in
                if pick.time {
                    pick.onPick(pick.day, CivilClock.time(date))
                } else {
                    pick.onPick(CivilClock.day(date), pick.clock)
                }
            }
        }
        .presentationDetents(pick.time ? [.medium] : [.large])
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("civil-pick-sheet")
    }
}

private struct CivilPickStyle: ViewModifier {
    let time: Bool
    func body(content: Content) -> some View {
        if time { content.datePickerStyle(.wheel) } else { content.datePickerStyle(.graphical) }
    }
}
