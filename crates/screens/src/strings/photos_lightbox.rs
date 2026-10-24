//! The one-photograph screens' own sentences (lightbox, editor, duplicates and
//! its review): the ones `copy/photos.json` does not carry.

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
}
