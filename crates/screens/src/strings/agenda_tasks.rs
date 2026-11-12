//! The new task sheet's, the quick add toolbar's and the grouped details' own
//! words (#1173). The rest of a task's sentences are `strings::task`'s.

catalog! {
    plain field_list = ("List", "List");
    plain field_more_details = ("More details", "More details");
    plain more_details_empty = ("Priority, repeat, tags", "Priority, repeat, tags");
    plain priority_1 = ("!", "!");
    plain priority_2 = ("!!", "!!");
    plain priority_3 = ("!!!", "!!!");
    plain priority_1_spoken = ("Low priority", "Low priority");
    plain priority_2_spoken = ("Medium priority", "Medium priority");
    plain priority_3_spoken = ("High priority", "High priority");
    plain quick_date = ("Date", "Date");
    plain quick_tag = ("Tag", "Tag");
    plain quick_flag = ("Flag", "Flag");
    plain quick_flagged = ("Flagged", "Flagged");
    plain quick_link = ("Link", "Link");
    plain quick_photo = ("Photo", "Photo");
    plain quick_staged_group = ("Staged for the next reminder", "Staged for the next reminder");
    plain quick_staged_link = ("Link · {kind}", "Link · {kind}");
    plain quick_link_failed = ("Added, but the link to {title} did not save.", "Added, but the link to {title} did not save.");
    plain quick_photo_failed = ("Added, but the photo did not attach.", "Added, but the photo did not attach.");
    plain quick_staged_failed = ("Added, but {n} things staged with it did not attach.", "Added, but {n} things staged with it did not attach.");
    plain group_date_time = ("Date & time", "Date & time");
    plain group_organisation = ("Organisation", "Organisation");
    plain field_flag = ("Flag", "Flag");
    plain flag_off = ("Not flagged", "Not flagged");
}
