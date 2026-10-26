//! The one-photograph screens' own sentences (lightbox, editor, duplicates and
//! its review): the ones `strings::photos` does not carry.

catalog! {
    plain denied_title = ("Photos cannot read this vault", "Photos cannot read this vault");
    plain denied_body = (
        "Ask the owner of this vault for access.",
        "Ask the owner of this vault for access."
    );
    counted duplicate_copies = ("{n} copy", "{n} near-identical copies");
    plain duplicate_pixels = ("{width} × {height}", "{width} × {height}");
    plain duplicate_captured = ("{date} {clock}", "{date} {clock}");
    plain review_suggestion = (
        "This is the largest of these copies, by pixels.",
        "This is the largest of these copies, by pixels."
    );
    plain review_trash_failed = (
        "Centraid could not trash one of these copies.",
        "Centraid could not trash one of these copies."
    );
    plain size_kb = ("{n} KB", "{n} KB");
    plain size_mb = ("{n} MB", "{n} MB");
    plain size_gb = ("{n} GB", "{n} GB");

    plain edit_straighten = ("Straighten {degrees}", "Straighten {degrees}");
    plain edit_flip = ("Flip", "Flip");
    plain edit_flip_horizontal = ("Flip ↔", "Flip ↔");
    plain edit_flip_vertical = ("Flip ↕", "Flip ↕");
    plain edit_status = (
        "Crop {ratio} · rotation {degrees}{flip}",
        "Crop {ratio} · rotation {degrees}{flip}"
    );
    plain edit_status_flip = (" · {flip}", " · {flip}");
    plain edit_retry = ("Try again.", "Try again.");
    plain edit_no_vault = (
        "Centraid could not read the edited photo.",
        "Centraid could not read the edited photo."
    );
    plain edit_fallback_name = ("photo", "photo");
    plain not_in_vault = ("This photo is not in a vault yet.", "This photo is not in a vault yet.");
    plain utc = ("UTC", "UTC");
    plain captured_fact = ("{when} · {zone}", "{when} · {zone}");
    plain stamp_line = ("{clock} · {place}", "{clock} · {place}");
    counted trash_days_left = ("1 day left in the trash", "{n} days left in the trash");
    plain play_live = ("Live", "Live");
}
