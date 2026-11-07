//! The event page's own sentences (`agenda.event`): the words a finished fact
//! row, a guest heading and a spoken label are made of. The page's other words
//! (RSVP answers, the scope rows, the cancel confirm) are `strings::agenda`'s.
//!
//! The attachments section and a task's link are drawn by the task page too, so
//! their words are here, beside the event's: one place for what both pages say
//! of what is attached (#1173).

catalog! {
    plain date_range = ("{from} – {to}", "{from} – {to}");
    plain day_long = ("{weekday} {day} {month}", "{weekday} {day} {month}");
    plain add_denied_error = ("Allow access in Settings to add it.", "Allow access in Settings to add it.");
    plain add_failed_error = ("That could not be added.", "That could not be added.");
    plain add_file_label = ("Add file", "Add file");
    plain add_photo_label = ("Add photo", "Add photo");
    plain add_unavailable_error = ("This phone has no picker for that.", "This phone has no picker for that.");
    plain adding_status = ("Adding {name}", "Adding {name}");
    plain adding_unnamed_status = ("Adding", "Adding");
    plain attachment_kind_file = ("File", "File");
    plain attachment_kind_image = ("Image", "Image");
    plain attachment_kind_pdf = ("PDF", "PDF");
    plain attachment_kind_photo = ("Photo", "Photo");
    plain attachment_kind_text = ("Text", "Text");
    plain attachment_meta = ("{kind} · {size}", "{kind} · {size}");
    plain attachment_spoken = ("{name}, {kind}", "{name}, {kind}");
    plain attachment_untitled = ("Untitled", "Untitled");
    plain attachments_empty = ("Nothing attached yet.", "Nothing attached yet.");
    plain attachments_heading = ("Attachments", "Attachments");
    plain attachments_heading_counted = ("Attachments · {count}", "Attachments · {count}");
    plain attachments_more_label = ("Show more", "Show more");
    plain followed_guest_unnamed = ("Guest", "Guest");
    counted followed_heading = ("{n} guest on your calendar", "{n} guests on your calendar");
    plain guest_awaiting_suffix = ("{heading} · {awaiting} awaiting", "{heading} · {awaiting} awaiting");
    counted guest_count = ("{n} guest", "{n} guests");
    plain guest_name_you = ("{name} · you", "{name} · you");
    plain guest_spoken = ("{name}, {reply}", "{name}, {reply}");
    plain link_label = ("Link", "Link");
    plain link_open_label = ("Open link", "Open link");
    plain link_spoken_label = ("Open link {url}", "Open link {url}");
    plain remove_file_body = ("It comes off here. The file stays in Docs.", "It comes off here. The file stays in Docs.");
    plain remove_label = ("Remove", "Remove");
    plain remove_photo_body = ("It comes off here. The photo stays in Photos.", "It comes off here. The photo stays in Photos.");
    plain remove_spoken_label = ("Remove {name}", "Remove {name}");
    plain remove_title = ("Remove this attachment?", "Remove this attachment?");
    counted reminder_minutes_before = ("{n} minute before", "{n} minutes before");
    plain spoken_range = ("{from} to {to}", "{from} to {to}");
}
