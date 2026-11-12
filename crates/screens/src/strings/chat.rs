//! The chat's sentences (the on-device assistant). The write-proposal sentences the assistant
//! itself composes ("Done.", "Proposed: …") are the core's (`copy/chat.json`, `SAID_*`, read by `crates/assist`); these are
//! the ones the screen says.

catalog! {
    plain a11y_answer = ("Centraid said", "Centraid said");
    plain a11y_attached = ("Attached", "Attached");
    plain a11y_destructive = ("Removes something", "Removes something");
    plain a11y_proposal = ("Proposed change", "Proposed change");
    plain a11y_you = ("You said", "You said");
    counted ago_days = ("{n} days ago", "{n} days ago");
    counted ago_hours = ("{n} hr ago", "{n} hr ago");
    plain ago_just_now = ("Just now", "Just now");
    counted ago_minutes = ("{n} min ago", "{n} min ago");
    plain attach = ("Attach", "Attach");
    plain attach_document = ("Document", "Document");
    plain attach_library_photo = ("Photo library", "Photo library");
    plain attach_no_documents = ("No text documents yet.", "No text documents yet.");
    plain attach_pick_document = ("Choose a document", "Choose a document");
    plain attach_vault_photo = ("Photo from vault", "Photo from vault");
    plain cancel = ("Cancel", "Cancel");
    plain card_gone = ("This item is gone.", "This item is gone.");
    plain chip_document = ("Document", "Document");
    plain chip_photo = ("Photo", "Photo");
    plain close = ("Close", "Close");
    plain composer_placeholder = ("Ask your vault", "Ask your vault");
    plain confirm = ("Confirm", "Confirm");
    plain copied = ("Copied", "Copied");
    plain copy = ("Copy", "Copy");
    plain jump_to_latest = ("Jump to latest", "Jump to latest");
    plain latest = ("Latest", "Latest");
    plain dictate = ("Dictate", "Dictate");
    plain dictation_off = (
        "Dictation is off. Allow the microphone and speech in Settings.",
        "Dictation is off. Allow the microphone and speech in Settings."
    );
    plain listening = ("Listening on this phone", "Listening on this phone");
    plain current_chat = ("Open chat", "Open chat");
    plain cancel_edit = ("Cancel editing", "Cancel editing");
    plain delete = ("Delete", "Delete");
    plain delete_all = ("Delete all chats", "Delete all chats");
    plain delete_all_body = (
        "Every chat in this vault is removed. This cannot be undone.",
        "Every chat in this vault is removed. This cannot be undone."
    );
    plain delete_all_title = ("Delete all chats?", "Delete all chats?");
    plain delete_body = (
        "Its messages are removed from this vault. This cannot be undone.",
        "Its messages are removed from this vault. This cannot be undone."
    );
    plain delete_title = ("Delete this chat?", "Delete this chat?");
    plain checking_body = (
        "Looking at memory and free space for the model.",
        "Looking at memory and free space for the model."
    );
    plain checking_title = ("Checking this phone", "Checking this phone");
    plain check_again = ("Check again", "Check again");
    plain download_action = ("Download on Wi‑Fi", "Download on Wi‑Fi");
    plain download_now = ("Download now", "Download now");
    plain download_failed = ("Download stopped. Try again.", "Download stopped. Try again.");
    plain download_note = (
        "It stays on this phone, and nothing you ask leaves it.",
        "It stays on this phone, and nothing you ask leaves it."
    );
    plain download_photo_note = (
        "Photos need a second download of {size}, asked for the first time you attach one.",
        "Photos need a second download of {size}, asked for the first time you attach one."
    );
    plain downloading_note = (
        "If the download stops, it carries on from here.",
        "If the download stops, it carries on from here."
    );
    plain low_space_body = (
        "The model needs {need} and this phone has {free} free. Free up {short}, then check again.",
        "The model needs {need} and this phone has {free} free. Free up {short}, then check again."
    );
    plain low_space_title = ("Not enough space", "Not enough space");
    plain mobile_data_body = (
        "The model is {size}. Downloading it now uses that much of your mobile data.",
        "The model is {size}. Downloading it now uses that much of your mobile data."
    );
    plain mobile_data_title = ("Use mobile data?", "Use mobile data?");
    plain download_progress = ("Downloading {percent}", "Downloading {percent}");
    plain download_progress_unknown = ("Downloading", "Downloading");
    plain drawer_label = ("Chats", "Chats");
    plain drawer_search_no_match = ("No chats match “{term}”.", "No chats match “{term}”.");
    plain drawer_search_placeholder = ("Search chats", "Search chats");
    plain empty_line = ("Ask about anything in your vault.", "Ask about anything in your vault.");
    plain error_attach_too_large = ("That attachment is too large.", "That attachment is too large.");
    plain error_attach_unreadable = ("That attachment would not open.", "That attachment would not open.");
    plain error_attach_unsupported = (
        "Chat reads photos and text documents.",
        "Chat reads photos and text documents."
    );
    plain error_generic = ("Chat could not answer. Try again.", "Chat could not answer. Try again.");
    plain error_model = ("The model stopped. Try again.", "The model stopped. Try again.");
    plain error_no_tool = ("Nothing in your vault answers that.", "Nothing in your vault answers that.");
    plain error_read = ("Chat could not read your vault. Try again.", "Chat could not read your vault. Try again.");
    plain error_too_long = (
        "That is too long for Chat to read at once. Shorten it and try again.",
        "That is too long for Chat to read at once. Shorten it and try again."
    );
    plain error_thread_write = (
        "That change was not saved. Try again.",
        "That change was not saved. Try again."
    );
    plain error_thread_gone = ("This chat is gone.", "This chat is gone.");
    plain error_vision = ("The photo reader is not loaded. Try again.", "The photo reader is not loaded. Try again.");
    plain loading = ("Loading model", "Loading model");
    plain load_failed = (
        "The model would not load. Download it again.",
        "The model would not load. Download it again."
    );
    plain looking = ("Looking in {app}", "Looking in {app}");
    plain menu_label = ("Chat options", "Chat options");
    counted more_steps = ("and {n} more", "and {n} more");
    plain new_chat = ("New chat", "New chat");
    plain note_doc_truncated = ("Read the first part of the document.", "Read the first part of the document.");
    plain not_now = ("Not now", "Not now");
    plain not_done = ("Not done.", "Not done.");
    plain made_by_chat = ("Made by Chat", "Made by Chat");
    plain reading_document = ("Reading the document", "Reading the document");
    plain reading_photo = ("Reading the photo", "Reading the photo");
    plain edit = ("Edit", "Edit");
    plain editing_body = (
        "Chat’s answer to it is replaced when you send.",
        "Chat’s answer to it is replaced when you send."
    );
    plain editing_title = ("Editing your question", "Editing your question");
    plain proposal_title = ("Proposed change", "Proposed change");
    plain remove_attachment = ("Remove", "Remove");
    plain rename = ("Rename", "Rename");
    plain rename_title = ("Rename chat", "Rename chat");
    plain retry = ("Try again", "Try again");
    plain save = ("Save", "Save");
    plain scope_all = ("All apps", "All apps");
    plain scope_label = ("Chat scope", "Chat scope");
    plain send = ("Send", "Send");
    plain photo_reader_body = (
        "Reading a photo needs a second download of {size}. It stays on this phone, and the photo never leaves it.",
        "Reading a photo needs a second download of {size}. It stays on this phone, and the photo never leaves it."
    );
    plain photo_reader_title = ("Download the photo reader?", "Download the photo reader?");
    plain use_mobile_data = ("Use mobile data instead", "Use mobile data instead");
    plain use_mobile_data_rest = ("Use mobile data for the rest", "Use mobile data for the rest");
    plain wait_wifi = ("Wait for Wi‑Fi", "Wait for Wi‑Fi");
    plain waiting_wifi = ("Waiting for Wi‑Fi", "Waiting for Wi‑Fi");
    plain waiting_wifi_note = (
        "The download carries on by itself when this phone joins Wi‑Fi.",
        "The download carries on by itself when this phone joins Wi‑Fi."
    );
    plain size_line = ("{size} download", "{size} download");
    plain stop = ("Stop", "Stop");
    plain did_not_finish = ("Did not finish", "Did not finish");
    plain stopped = ("Stopped", "Stopped");
    plain subtitle = ("On this phone", "On this phone");
    plain subtitle_vault = ("{vault} · on this phone", "{vault} · on this phone");
    plain thinking = ("Thinking", "Thinking");
    plain threads_empty = ("No chats yet.", "No chats yet.");
    plain title = ("Chat", "Chat");
    plain unlock_reason = ("Unlock Locker to confirm this change", "Unlock Locker to confirm this change");
    plain unlock_subtitle = ("Confirm it is you", "Confirm it is you");
    plain unlock_title = ("Unlock Locker", "Unlock Locker");
    plain unavailable_memory = (
        "It needs 4 GB of memory and this phone has {have}.",
        "It needs 4 GB of memory and this phone has {have}."
    );
    plain unavailable_title = ("Chat can’t run on this phone", "Chat can’t run on this phone");
    plain unavailable = ("Chat is not available here.", "Chat is not available here.");
    plain vision_action = ("Download", "Download");
    plain vision_line = ("Reading photos needs a {size} download", "Reading photos needs a {size} download");
    plain vision_loading = ("Loading photo reader", "Loading photo reader");
    plain vision_load_failed = (
        "The photo reader would not load. Download it again.",
        "The photo reader would not load. Download it again."
    );
}
