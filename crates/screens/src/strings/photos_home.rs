//! Sentences of `photos.home` and of the pieces Photos' screens share that no
//! `copy/photos.json` key covers: how a fetched original ended, a copy handed to
//! the platform, "Keep originals" and "Free up space", and the library's own
//! small words. Keys keep the names the Kotlin constants they replace had.

catalog! {
    // How fetching one original back ended (`SharedCopy.FETCH_*`).
    plain fetch_unreachable = ("Can't reach your backup device. Try again later.", "Can't reach your backup device. Try again later.");
    plain fetch_not_in_backup = ("Your backup device doesn't hold this original.", "Your backup device doesn't hold this original.");
    plain fetch_untrusted = ("That isn't your backup device.", "That isn't your backup device.");
    plain fetch_damaged = ("Couldn't open the backup copy of this original.", "Couldn't open the backup copy of this original.");
    plain fetch_no_answer = ("Couldn't get the original back. Try again.", "Couldn't get the original back. Try again.");

    // A copy of a pick handed to the platform (`ShelfCopies`).
    plain copy_none_here = ("The originals are not on this phone, so nothing was sent.", "The originals are not on this phone, so nothing was sent.");
    plain copy_missing_one = ("1 original is not on this phone, so it was left out.", "1 original is not on this phone, so it was left out.");
    plain copy_missing_many = ("{count} originals are not on this phone, so they were left out.", "{count} originals are not on this phone, so they were left out.");
    plain copy_saved_many = ("{count} saved to your photos.", "{count} saved to your photos.");
    plain copy_export_failed = ("Photos not exported. Try again.", "Photos not exported. Try again.");
    plain copy_location_not_removable = ("Could not remove the location from every file, so nothing was sent.", "Could not remove the location from every file, so nothing was sent.");

    // "Keep originals on this phone" and "Free up space" (`KeepOriginals`).
    plain keep_checking = ("Checking this album's originals", "Checking this album's originals");
    plain keep_unreadable = ("This album's setting could not be read.", "This album's setting could not be read.");
    plain keep_meta_kept = ("Kept out of Free up space", "Kept out of Free up space");
    plain keep_meta_included = ("Included in Free up space", "Included in Free up space");
    plain free_up_counting = ("Counting the originals on this phone…", "Counting the originals on this phone…");
    plain free_up_not_counted = ("Not counted yet.", "Not counted yet.");
    plain free_up_nothing_safe = ("None can be freed yet. Originals free up once a backup device holds them.", "None can be freed yet. Originals free up once a backup device holds them.");
    plain free_up_not_checked = ("Centraid could not check which originals are backed up, so none is offered.", "Centraid could not check which originals are backed up, so none is offered.");
    plain free_up_action = ("Free up {size}", "Free up {size}");
    plain free_up_freed = ("Freed {size}. Photos download again from your backup device when you open them.", "Freed {size}. Photos download again from your backup device when you open them.");
    plain free_up_nothing_removed = ("Nothing removed.", "Nothing removed.");
    plain free_up_not_recorded = ("Photos removed from this phone. They show as downloadable once Centraid catches up.", "Photos removed from this phone. They show as downloadable once Centraid catches up.");
    plain free_up_no_originals = ("No originals on this phone", "No originals on this phone");
    plain free_up_backed_up_one = ("1 photo is backed up.", "1 photo is backed up.");
    plain free_up_backed_up_many = ("{count} photos are backed up.", "{count} photos are backed up.");
    plain free_up_original_one = ("original", "original");
    plain free_up_original_many = ("originals", "originals");
    plain free_up_meta = ("{count} {noun} · {size} on this phone", "{count} {noun} · {size} on this phone");
    plain free_up_kept_one = (" One of them is in an album you keep on this phone.", " One of them is in an album you keep on this phone.");
    plain free_up_kept_many = (" {count} of them are in albums you keep on this phone.", " {count} of them are in albums you keep on this phone.");

    // The library and its sheets.
    plain library_copy_place_title = ("Include which location?", "Include which location?");
    plain library_copy_no_location = ("No location", "No location");
    plain library_copy_exact_location = ("Exact location", "Exact location");
    plain library_albums_trash = ("Recently deleted albums", "Recently deleted albums");
    plain library_albums_restore = ("Restore", "Restore");
    plain library_albums_trash_purge = ("Purges in {days} days", "Purges in {days} days");
    plain library_albums_trash_purge_one = ("Purges in 1 day", "Purges in 1 day");
    plain library_albums_trash_soon = ("Purges soon", "Purges soon");
    plain library_new_album_title = ("New album", "New album");
    plain library_new_album_placeholder = ("Album name", "Album name");
    plain library_standing_favorites = ("Favorites", "Favorites");
    plain library_standing_archive = ("Archive", "Archive");
    plain library_standing_trash = ("Trash", "Trash");
    plain library_standing_videos = ("Videos", "Videos");
    plain library_standing_library = ("Library", "Library");
    plain library_door_places = ("Places", "Places");
    plain library_door_duplicates = ("Duplicates", "Duplicates");
    plain library_search_albums = ("Albums", "Albums");
    plain library_search_places = ("Places", "Places");
    plain library_search_labels = ("Labels", "Labels");
    plain library_search_no_location = ("No location", "No location");
    plain library_search_matched_album = ("Album", "Album");
    plain library_search_matched_place = ("Place", "Place");
    plain library_search_matched_label = ("Label", "Label");
    plain library_search_matched_title = ("Caption", "Caption");
    plain library_search_matched_text = ("Text in the photo", "Text in the photo");
    plain library_importing_remedy_allow = ("Allow photo access", "Allow photo access");
}
