//! The one-photograph screens' own sentences (lightbox and editor): the ones `strings::photos` does not carry.

catalog! {
    plain denied_title = ("Photos cannot read this vault", "Photos cannot read this vault");
    plain denied_body = (
        "Ask the owner of this vault for access.",
        "Ask the owner of this vault for access."
    );
    plain pixel_box = ("{width} × {height}", "{width} × {height}");

    plain edit_straighten = ("Straighten {degrees}", "Straighten {degrees}");
    plain edit_flip = ("Flip", "Flip");
    plain edit_flip_horizontal = ("Flip ↔", "Flip ↔");
    plain edit_flip_vertical = ("Flip ↕", "Flip ↕");
    plain edit_status_crop = ("Cropped to {ratio}", "Cropped to {ratio}");
    plain edit_status_rotate = ("Rotated {degrees}", "Rotated {degrees}");
    plain edit_status_flip_horizontal = ("Flipped left to right", "Flipped left to right");
    plain edit_status_flip_vertical = ("Flipped top to bottom", "Flipped top to bottom");
    plain edit_retry = ("Try again.", "Try again.");
    plain edit_no_vault = (
        "Centraid could not read the edited photo.",
        "Centraid could not read the edited photo."
    );
    plain edit_fallback_name = ("photo", "photo");
    plain not_in_vault = ("This photo is not in a vault yet.", "This photo is not in a vault yet.");
    plain link_added = ("Linked", "Linked");
    plain link_removed = ("Link removed", "Link removed");
    plain links_empty = ("Nothing linked yet", "Nothing linked yet");
    plain links_unread = (
        "Couldn’t read what this photo is linked to.",
        "Couldn’t read what this photo is linked to."
    );
    plain person_added = ("Person added", "Person added");
    plain person_removed = ("Person removed", "Person removed");
    plain caption_changed = ("Caption changed", "Caption changed");
    plain label_added = ("Label added", "Label added");
    plain label_removed = ("Label removed", "Label removed");
    plain place_changed = ("Place changed", "Place changed");
    plain utc = ("UTC", "UTC");
    plain earlier_caption = ("Caption: {caption}", "Caption: {caption}");
    plain earlier_no_caption = ("No caption", "No caption");
    plain earlier_no_place = ("No place", "No place");
    plain captured_fact = ("{when} · {zone}", "{when} · {zone}");
    plain stamp_line = ("{clock} · {place}", "{clock} · {place}");
    counted trash_days_left = ("1 day left in the trash", "{n} days left in the trash");
    plain play_live = ("Live", "Live");
}
