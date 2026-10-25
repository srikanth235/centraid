//! Sentences of `photos.shelf`, `photos.picker` and `photos.places` that no
//! `copy/photos.json` key covers: each shelf's own title and empty sentence, the
//! trash's rule, and the album's small words. Keys keep the names the Kotlin
//! constants they replace had.

catalog! {
    plain title_videos = ("Videos", "Videos");
    plain empty_album = ("Nothing in this album yet.", "Nothing in this album yet.");
    plain empty_every_photo_placed = ("Every photo has a place.", "Every photo has a place.");
    plain empty_place = ("No photos at {name} yet.", "No photos at {name} yet.");
    plain empty_trash = ("Trash is empty.", "Trash is empty.");
    plain empty_videos = ("Videos you capture or import collect here.", "Videos you capture or import collect here.");
    plain purge_window = (
        "Photos here are deleted forever {days} days after you trash them.",
        "Photos here are deleted forever {days} days after you trash them."
    );
    plain album_in_trash = ("This album is in the trash.", "This album is in the trash.");
    plain album_restore = ("Restore album", "Restore album");
    plain write_refused = ("Centraid could not make that change.", "Centraid could not make that change.");
    plain place_unnamed_shelf = ("A place with no name yet", "A place with no name yet");
}
