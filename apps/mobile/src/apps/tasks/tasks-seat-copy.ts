export const SEARCH_UNREACHABLE_TITLE = "Search asks the vault, not this phone";
export const SEARCH_UNREACHABLE_BODY =
  "The index that matches these words sits beside the gateway, out of reach right now.";
export const SEARCH_IDLE = "Type to search your tasks by title and note.";
export function searchHits(count: number): string {
  return `${count} · ranked by the vault`;
}

export const REMINDER_SEAT_NOTE =
  "This is the seat that delivers them · the moment is the vault's.";
export const REMINDER_NONE = "No task here carries a reminder yet.";

export function logbookShown(count: number): string {
  return `${count} · what this device has synced, not the whole Logbook`;
}

export const ATTACHED_SEAT_NOTE = "Pinned where the files are, not from here.";

export const NOTE_PLACEHOLDER = "A note, for the version of you on Friday";
export const TAG_PLACEHOLDER = "Add a tag";

export const READING_TASKS = "Reading your tasks";

export const PROJECT_NAME_PLACEHOLDER = "What is this project for?";
export const TASK_NAME_PLACEHOLDER = "What is it?";
