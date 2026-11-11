//! The "phone says" line (#1183), once for the four detail screens that draw it: the lead, the one
//! action and what the action says to a screen reader, in the store's own name. A screen's nouns
//! ("name", "number", "distance") are its app's.

catalog! {
    plain back_action = ("Add back", "Add back");
    plain back_folder_spoken = (
        "Add back the {noun} {value} from the folder",
        "Add back the {noun} {value} from the folder"
    );
    plain back_phone_spoken = (
        "Add back the {noun} {value} from your phone",
        "Add back the {noun} {value} from your phone"
    );
    plain back_store_spoken = (
        "Add back the {noun} {value} from {store}",
        "Add back the {noun} {value} from {store}"
    );
    plain has_folder_lead = ("Folder still has {value}", "Folder still has {value}");
    plain has_phone_lead = ("Phone still has {value}", "Phone still has {value}");
    plain has_store_lead = ("{store} still has {value}", "{store} still has {value}");
    plain says_folder_lead = ("Folder says {value}", "Folder says {value}");
    plain says_phone_lead = ("Phone says {value}", "Phone says {value}");
    plain says_store_lead = ("{store} says {value}", "{store} says {value}");
    plain use_folder_action = ("Use folder’s", "Use folder’s");
    plain use_folder_spoken = (
        "Use the {noun} the folder has, {value}",
        "Use the {noun} the folder has, {value}"
    );
    plain use_phone_action = ("Use phone’s", "Use phone’s");
    plain use_phone_spoken = (
        "Use the {noun} your phone has, {value}",
        "Use the {noun} your phone has, {value}"
    );
    plain use_store_action = ("Use {store}’s", "Use {store}’s");
    plain use_store_spoken = (
        "Use the {noun} {store} has, {value}",
        "Use the {noun} {store} has, {value}"
    );
    plain unchecked_folder_status = (
        "Couldn’t check what the folder says.",
        "Couldn’t check what the folder says."
    );
    plain unchecked_phone_status = (
        "Couldn’t check what your phone says.",
        "Couldn’t check what your phone says."
    );
    plain unchecked_store_status = (
        "Couldn’t check what {store} says.",
        "Couldn’t check what {store} says."
    );
    plain doubted_status = (
        "Far fewer items than before in {source}, so nothing was removed.",
        "Far fewer items than before in {source}, so nothing was removed."
    );
    plain incomplete_status = (
        "Only part of {source} was readable, so this shows what was read.",
        "Only part of {source} was readable, so this shows what was read."
    );
    plain source_calendar = ("your phone’s calendars", "your phone’s calendars");
    plain source_contacts = ("your phone’s contacts", "your phone’s contacts");
    plain source_files = ("the folder", "the folder");
    plain source_health = ("your health store", "your health store");

    plain reconnect_title = ("Reconnect", "Reconnect");
    plain reconnect_lede = (
        "Connect each store another phone followed to follow it here.",
        "Connect each store another phone followed to follow it here."
    );
    plain reconnect_none = ("Nothing to reconnect", "Nothing to reconnect");
    plain reconnect_connect = ("Connect", "Connect");
    plain reconnect_contacts = ("Phone contacts", "Phone contacts");
    plain reconnect_calendars = ("Phone calendars", "Phone calendars");
    plain reconnect_folder = ("{label} folder", "{label} folder");
    plain reconnect_failed = (
        "Couldn’t read what the vault followed.",
        "Couldn’t read what the vault followed."
    );
}
