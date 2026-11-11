//! The words of People's lists page (`people.lists`, #1185): making a list, renaming it and moving it to
//! the trash. The trash's own words ("moved to trash", "Undo", "Move to trash") are the kit's
//! (`strings::shared`).

catalog! {
    plain cancel = ("Cancel", "Cancel");
    plain create = ("Create", "Create");
    plain created = ("{name} created", "{name} created");
    plain empty_body = (
        "A list keeps the people you want together, like Family or Work.",
        "A list keeps the people you want together, like Family or Work."
    );
    plain empty_headline = ("No lists yet", "No lists yet");
    counted members = ("{n} person", "{n} people");
    plain more_row = ("Lists", "Lists");
    plain name_placeholder = ("List name", "List name");
    plain new_list = ("New list", "New list");
    plain renamed = ("Renamed to {name}", "Renamed to {name}");
    plain row_a11y = ("{name}, {meta}", "{name}, {meta}");
    plain save = ("Save", "Save");
    plain sheet_new = ("New list", "New list");
    plain sheet_rename = ("Rename list", "Rename list");
    plain title = ("Lists", "Lists");
}
