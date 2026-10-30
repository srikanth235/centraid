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
    plain current_chat = ("Open chat", "Open chat");
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
    plain download_action = ("Download model", "Download model");
    plain download_failed = ("Download stopped. Retry.", "Download stopped. Retry.");
    plain download_note = (
        "This is the only time Centraid fetches anything.",
        "This is the only time Centraid fetches anything."
    );
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
    plain error_generic = ("Chat could not answer. Retry.", "Chat could not answer. Retry.");
    plain error_model = ("The model stopped. Retry.", "The model stopped. Retry.");
    plain error_no_tool = ("Nothing in your vault answers that.", "Nothing in your vault answers that.");
    plain error_read = ("Chat could not read your vault. Retry.", "Chat could not read your vault. Retry.");
    plain error_thread_gone = ("This chat is gone.", "This chat is gone.");
    plain error_vision = ("The photo reader is not loaded. Retry.", "The photo reader is not loaded. Retry.");
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
    plain not_done = ("Not done.", "Not done.");
    plain reading_document = ("Reading the document", "Reading the document");
    plain reading_photo = ("Reading the photo", "Reading the photo");
    plain remove_attachment = ("Remove", "Remove");
    plain rename = ("Rename", "Rename");
    plain rename_title = ("Rename chat", "Rename chat");
    plain retry = ("Try again", "Try again");
    plain save = ("Save", "Save");
    plain scope_all = ("All apps", "All apps");
    plain scope_label = ("Chat scope", "Chat scope");
    plain send = ("Send", "Send");
    plain size_line = ("{size} download", "{size} download");
    plain stop = ("Stop", "Stop");
    plain stopped = ("Stopped", "Stopped");
    plain subtitle = ("On this phone", "On this phone");
    plain subtitle_vault = ("{vault} · on this phone", "{vault} · on this phone");
    plain thinking = ("Thinking", "Thinking");
    plain threads_empty = ("No chats yet.", "No chats yet.");
    plain title = ("Chat", "Chat");
    plain unlock_reason = ("Unlock Locker to confirm this change", "Unlock Locker to confirm this change");
    plain unlock_subtitle = ("Confirm it is you", "Confirm it is you");
    plain unlock_title = ("Unlock Locker", "Unlock Locker");
    plain unavailable = ("Chat is not available here.", "Chat is not available here.");
    plain vision_action = ("Download", "Download");
    plain vision_line = ("Reading photos needs a {size} download", "Reading photos needs a {size} download");
    plain vision_loading = ("Loading photo reader", "Loading photo reader");
    plain vision_load_failed = (
        "The photo reader would not load. Download it again.",
        "The photo reader would not load. Download it again."
    );
}
