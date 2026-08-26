// Desktop and mobile draw the SAME Home in two renderers, so a string either
// can show has exactly one spelling here (#708).

export const HOME_FIRST_RUN_TITLE = "Nothing in here yet";

export const HOME_FIRST_RUN_BODY =
  "Bring your photographs and documents in and this becomes the front of your own archive.";

export const HOME_DAY_ONE_SEED_LABEL = "Fill it with sample content";
export const HOME_DAY_ONE_PHOTOS_LABEL = "Bring in photographs";
export const HOME_DAY_ONE_DOCS_LABEL = "Bring in documents";

export function homeDayOneFoot(appsInstalled: number, things: number): string {
  return `${appsInstalled} apps installed · ${things} things · sample content can be removed in one action`;
}

// FOUR, never one-per-installed-app: eight reads as eight empty tiles.
export const HOME_FIRST_RUN_PLACEHOLDERS = 4;

export const HOME_START_TITLE = "Fill this out";

export const HOME_START_LEAD = "Start with";

// VERB FIRST, and each must land somewhere that can take content.
export interface HomeFirstMoveCopy {
  label: string;
  hint: string;
}

export const HOME_FIRST_MOVE_COPY: Readonly<Record<string, HomeFirstMoveCopy>> =
  {
    agenda: { hint: "Your week, on the front page.", label: "Add an event" },
    connectors: {
      hint: "Mail, calendar and contacts arrive on their own.",
      label: "Connect an account",
    },
    docs: { hint: "Versioned, restorable, yours.", label: "File a document" },
    locker: { hint: "Passwords, behind the lock.", label: "Save a secret" },
    notes: { hint: "The newest one shows up here.", label: "Write a note" },
    people: { hint: "The people you keep up with.", label: "Add someone" },
    photos: { hint: "The newest ones surface here.", label: "Bring in photos" },
    tally: { hint: "Who owes whom, settled.", label: "Log a shared expense" },
    tasks: { hint: "The next thing to do.", label: "Add a task" },
  };

// Sample copy says "sample" before anything else, says who made it up, and says
// how to remove it — in that order, every time it appears.
export const HOME_SAMPLE_OFFER_LEAD = "Not sure what this looks like full?";

export const HOME_SAMPLE_OFFER_LABEL = "Fill it with a sample week";

export const HOME_SAMPLE_OFFER_HINT =
  "Invented content in the real structure — nothing leaves this device, and one tap clears it.";

export const HOME_SAMPLE_LOADED_TITLE = "Sample data";

export const HOME_SAMPLE_LOADED_BODY =
  "The rows below are made up; clearing them leaves your own additions untouched.";

export const HOME_SAMPLE_CLEAR = "Clear the sample";

export const HOME_SAMPLE_FILLING = "Filling your vault with a sample week…";

export const HOME_SAMPLE_FILLING_APP: Readonly<Record<string, string>> = {
  agenda: "Adding events…",
  docs: "Adding documents…",
  locker: "Adding secrets…",
  notes: "Adding notes…",
  people: "Adding people…",
  photos: "Adding photographs…",
  tally: "Adding shared expenses…",
  tasks: "Adding tasks…",
};

export const HOME_SAMPLE_FILLING_CATCH_UP = "Catching up…";

export const HOME_SAMPLE_FILLING_UNIT = "apps";
