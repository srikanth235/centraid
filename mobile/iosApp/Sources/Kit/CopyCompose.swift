import Foundation

import CentraidShared

// THE TWO PLACES A SENTENCE IS COMPOSED ON THIS SIDE OF THE BRIDGE.
//
// `copy/<app>.json` is strings only (`:shared:generateCopy` says so in the
// header of every table it writes), and a view reads a string as
// `PhotosCopy.shared.KEY` with nothing between. A function that closes a hole
// in a template, or picks a string by a screen enum, composes a sentence and so
// is the reader's to write — and these two have more than one reader.

/// Closes one `{hole}` in a template.
func copyFill(_ template: String, _ hole: String, _ value: String) -> String {
    template.replacingOccurrences(of: "{\(hole)}", with: value)
}

/// The import's verb for a day-one empty state, by where the phone holds the data.
func importLabel(_ source: Centraid_Screen_V1_ImportSource) -> String {
    switch source {
    case .contacts: return PeopleCopy.shared.IMPORT_CONTACTS
    case .calendar: return AgendaCopy.shared.IMPORT_CALENDAR
    case .reminders: return TasksCopy.shared.IMPORT_REMINDERS
    default: return ""
    }
}
