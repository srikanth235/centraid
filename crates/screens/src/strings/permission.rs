//! THE ONE PERMISSION VOICE (#1185): what every ask and every refusal of a phone grant says, for every
//! resource that has one. `kit::permission` picks the sentence; the shells report the state and word nothing.
//!
//! Four states, one shape each: not asked ("Centraid needs access to ..."), refused (it is off; Settings
//! turns it on), restricted (the phone itself does not allow it; there is no Settings pointer, because
//! no button here can change it) and limited (a grant that is not enough for what the resource is for).

catalog! {
    plain photos_not_asked = ("Centraid needs access to your photos.", "Centraid needs access to your photos.");
    plain photos_refused = ("Photo access is off. Turn it on in Settings.", "Photo access is off. Turn it on in Settings.");
    plain photos_restricted = ("This phone does not allow photo access.", "This phone does not allow photo access.");
    plain calendar_not_asked = ("Centraid needs access to your calendar.", "Centraid needs access to your calendar.");
    plain calendar_refused = ("Calendar access is off. Turn it on in Settings.", "Calendar access is off. Turn it on in Settings.");
    plain calendar_restricted = ("This phone does not allow calendar access.", "This phone does not allow calendar access.");
    plain contacts_not_asked = ("Centraid needs access to your contacts.", "Centraid needs access to your contacts.");
    plain contacts_refused = ("Contacts access is off. Turn it on in Settings.", "Contacts access is off. Turn it on in Settings.");
    plain contacts_restricted = ("This phone does not allow contacts access.", "This phone does not allow contacts access.");
    plain reminders_not_asked = ("Centraid needs access to your reminders.", "Centraid needs access to your reminders.");
    plain reminders_refused = ("Reminders access is off. Turn it on in Settings.", "Reminders access is off. Turn it on in Settings.");
    plain reminders_restricted = ("This phone does not allow reminders access.", "This phone does not allow reminders access.");
    plain health_not_asked = ("Centraid needs access to Health.", "Centraid needs access to Health.");
    plain health_refused = ("Health access is off. Turn it on in Settings.", "Health access is off. Turn it on in Settings.");
    plain health_restricted = ("This phone does not allow Health access.", "This phone does not allow Health access.");
    plain camera_not_asked = ("Centraid needs access to the camera.", "Centraid needs access to the camera.");
    plain camera_refused = ("Camera access is off. Turn it on in Settings.", "Camera access is off. Turn it on in Settings.");
    plain camera_restricted = ("This phone does not allow camera access.", "This phone does not allow camera access.");
    plain files_not_asked = ("Centraid needs access to your files.", "Centraid needs access to your files.");
    plain files_refused = ("File access is off. Turn it on in Settings.", "File access is off. Turn it on in Settings.");
    plain files_restricted = ("This phone does not allow file access.", "This phone does not allow file access.");
    plain photos_limited = ("Centraid imports the photos you selected.", "Centraid imports the photos you selected.");
    plain calendar_limited = ("Centraid needs full calendar access, not only adding events. Turn it on in Settings.", "Centraid needs full calendar access, not only adding events. Turn it on in Settings.");
    plain contacts_limited = ("Centraid sees only the contacts you chose. Allow all contacts in Settings to bring in everyone.", "Centraid sees only the contacts you chose. Allow all contacts in Settings to bring in everyone.");
    plain reminders_limited = ("Centraid needs full access to your reminders. Turn it on in Settings.", "Centraid needs full access to your reminders. Turn it on in Settings.");
    plain notifications_not_asked = ("Centraid needs to send notifications to remind you.", "Centraid needs to send notifications to remind you.");
    plain notifications_refused = ("Notifications are off. Turn them on in Settings.", "Notifications are off. Turn them on in Settings.");
    plain notifications_restricted = ("This phone does not allow notifications.", "This phone does not allow notifications.");
}
