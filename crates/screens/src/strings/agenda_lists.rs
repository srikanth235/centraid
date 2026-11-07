//! The style sheet's words (#1173 wave 2): making a list or a calendar, and
//! changing its name, colour and icon. One sheet serves both, so most rows
//! are shared; a list and a calendar differ in the title, the name field and
//! the sentence the status line says.
//!
//! The colour and icon names are what a screen reader speaks for a swatch or a
//! glyph; [`color_name`] and [`icon_name`] answer one by its key.

use super::Locale;

catalog! {
    plain new_list_title = ("New List", "New List");
    plain edit_list_title = ("Edit List", "Edit List");
    plain new_calendar_title = ("New Calendar", "New Calendar");
    plain edit_calendar_title = ("Edit Calendar", "Edit Calendar");
    plain list_name_placeholder = ("List name", "List name");
    plain calendar_name_placeholder = ("Calendar name", "Calendar name");
    plain create = ("Create", "Create");
    plain save = ("Save", "Save");
    plain cancel = ("Cancel", "Cancel");
    plain color_label = ("Color", "Color");
    plain icon_label = ("Icon", "Icon");
    plain no_icon = ("No icon", "No icon");
    plain edit_calendar = ("Edit {name}", "Edit {name}");
    plain list_created = ("List created", "List created");
    plain list_updated = ("List updated", "List updated");
    plain calendar_created = ("Calendar created", "Calendar created");
    plain calendar_updated = ("Calendar updated", "Calendar updated");
    plain color_blue = ("Blue", "Blue");
    plain color_mustard = ("Mustard", "Mustard");
    plain color_violet = ("Violet", "Violet");
    plain color_petrol = ("Petrol", "Petrol");
    plain color_indigo = ("Indigo", "Indigo");
    plain color_graphite = ("Graphite", "Graphite");
    plain color_raspberry = ("Raspberry", "Raspberry");
    plain color_orchid = ("Orchid", "Orchid");
    plain icon_beaker = ("Beaker", "Beaker");
    plain icon_bell = ("Bell", "Bell");
    plain icon_bolt = ("Lightning", "Lightning");
    plain icon_book = ("Book", "Book");
    plain icon_bookmark = ("Bookmark", "Bookmark");
    plain icon_calendar = ("Calendar", "Calendar");
    plain icon_calendar_blank = ("Blank calendar", "Blank calendar");
    plain icon_camera = ("Camera", "Camera");
    plain icon_cloud = ("Cloud", "Cloud");
    plain icon_coin = ("Coin", "Coin");
    plain icon_compass = ("Compass", "Compass");
    plain icon_flag = ("Flag", "Flag");
    plain icon_folder = ("Folder", "Folder");
    plain icon_gift = ("Gift", "Gift");
    plain icon_globe = ("Globe", "Globe");
    plain icon_gym = ("Gym", "Gym");
    plain icon_habit = ("Habit", "Habit");
    plain icon_heart = ("Heart", "Heart");
    plain icon_home = ("Home", "Home");
    plain icon_inbox = ("Inbox", "Inbox");
    plain icon_journal = ("Journal", "Journal");
    plain icon_list = ("List", "List");
    plain icon_map_pin = ("Map pin", "Map pin");
    plain icon_moon = ("Moon", "Moon");
    plain icon_mood = ("Mood", "Mood");
    plain icon_music = ("Music", "Music");
    plain icon_pin = ("Pin", "Pin");
    plain icon_plant = ("Plant", "Plant");
    plain icon_receipt = ("Receipt", "Receipt");
    plain icon_star = ("Star", "Star");
    plain icon_sun = ("Sun", "Sun");
    plain icon_users = ("People", "People");
}

/// The spoken name of a `[list]` colour key; the key itself for one this does
/// not know (the vault refuses those, so a screen never asks).
#[must_use]
pub fn color_name(locale: Locale, key: &str) -> String {
    match key {
        "blue" => color_blue(locale),
        "mustard" => color_mustard(locale),
        "violet" => color_violet(locale),
        "petrol" => color_petrol(locale),
        "indigo" => color_indigo(locale),
        "graphite" => color_graphite(locale),
        "raspberry" => color_raspberry(locale),
        "orchid" => color_orchid(locale),
        other => other.to_owned(),
    }
}

/// The spoken name of an icon key of `LIST_ICONS`.
#[must_use]
pub fn icon_name(locale: Locale, key: &str) -> String {
    match key {
        "Beaker" => icon_beaker(locale),
        "Bell" => icon_bell(locale),
        "Bolt" => icon_bolt(locale),
        "Book" => icon_book(locale),
        "Bookmark" => icon_bookmark(locale),
        "Calendar" => icon_calendar(locale),
        "CalendarBlank" => icon_calendar_blank(locale),
        "Camera" => icon_camera(locale),
        "Cloud" => icon_cloud(locale),
        "Coin" => icon_coin(locale),
        "Compass" => icon_compass(locale),
        "Flag" => icon_flag(locale),
        "Folder" => icon_folder(locale),
        "Gift" => icon_gift(locale),
        "Globe" => icon_globe(locale),
        "Gym" => icon_gym(locale),
        "Habit" => icon_habit(locale),
        "Heart" => icon_heart(locale),
        "Home" => icon_home(locale),
        "Inbox" => icon_inbox(locale),
        "Journal" => icon_journal(locale),
        "List" => icon_list(locale),
        "MapPin" => icon_map_pin(locale),
        "Moon" => icon_moon(locale),
        "Mood" => icon_mood(locale),
        "Music" => icon_music(locale),
        "Pin" => icon_pin(locale),
        "Plant" => icon_plant(locale),
        "Receipt" => icon_receipt(locale),
        "Star" => icon_star(locale),
        "Sun" => icon_sun(locale),
        "Users" => icon_users(locale),
        other => other.to_owned(),
    }
}
