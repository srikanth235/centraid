// Home's cross-surface copy (issue #708, section A).
//
// Desktop (packages/client/src/react/screens/HomeSpringboard.tsx) and mobile
// (apps/mobile/src/screens/home/FirstRunGrid.tsx) draw the SAME Home in two
// renderers, so a string either surface can show has to have exactly one
// spelling. Before this module there were three first-run texts for one state —
// the brief's, desktop's paraphrase, and mobile's — which is the drift a shared
// constant exists to make impossible.
//
// Why here and not in `@centraid/design`: that package owns visual tokens and
// app metadata, not screen prose. `@centraid/client` is already the module
// boundary the two surfaces share (mobile imports `@centraid/client/capture`
// and `@centraid/client/replica/native`), so this is the narrowest existing
// seam that both can reach without inventing a new package.

/** First run — the vault has no content ANYWHERE. Verbatim from the brief. */
export const HOME_FIRST_RUN_TITLE = "Nothing here yet";

/** The body under it. One sentence about what Home becomes, one about custody. */
export const HOME_FIRST_RUN_BODY =
  "Bring your photographs and documents in and this becomes the front of your own archive. Everything you import stays on this device.";

/**
 * How many first moves the day-one treatment draws.
 *
 * FOUR, not one-per-installed-app: they are a picture of what Home will look
 * like, not a checklist of every app you own. Eight reads as eight empty tiles,
 * which is the exact thing the treatment replaces.
 */
export const HOME_FIRST_RUN_PLACEHOLDERS = 4;

/**
 * The heading over the start band — the strip that carries the apps with
 * nothing in them once at least one app HAS something.
 *
 * This state had no treatment at all: `isFirstRun` was binary, so the moment a
 * single note existed Home rendered all eight tiles and seven of them apologised
 * — the "eight apologies" the day-one copy was written to prevent, arriving one
 * note later. The band is the graded answer: a tile earns the grid by having
 * content, and everything else is an invitation rather than an absence.
 */
export const HOME_START_TITLE = "Fill this out";

/** Day one's own version of the same band's heading. */
export const HOME_START_LEAD = "Start with";

/**
 * How a first move is phrased, in the order they are offered.
 *
 * VERB FIRST, and every one of them lands somewhere that can actually take
 * content. The old placeholders opened the empty app they were named after,
 * which is a dead end wearing an invitation: you arrive at the same emptiness
 * one click deeper.
 *
 * Connecting an account leads because it is the only move whose result is
 * bigger than the act — mail, calendar and contacts arrive on their own
 * afterwards, so one decision fills three tiles.
 */
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

/** Home's own cross-app search entry point (the third of three; ⌘K and the
 *  stem's Search control are the other two). */
export const HOME_SEARCH_EVERYTHING = "Search everything";

// ── the sample ──────────────────────────────────────────────────────────────
//
// Every word here is doing one job: making sure nobody ever mistakes the sample
// for their own archive. The vault's whole promise is that what is in it is
// theirs, so the copy says "sample" before it says anything else, says who made
// it up, and says how to remove it — in that order, every time it appears.

/** The day-one offer. A question, not a step: the real moves come first. */
export const HOME_SAMPLE_OFFER_LEAD = "Not sure what this looks like full?";

export const HOME_SAMPLE_OFFER_LABEL = "Fill it with a sample week";

/** The two things a member must know BEFORE pressing, not after. */
export const HOME_SAMPLE_OFFER_HINT =
  "Invented content in the real structure — a week of events, notes, photos, documents, people and expenses. Nothing leaves this device, and one tap clears all of it.";

/** While the sample is loaded. Present tense, first word does the work. */
export const HOME_SAMPLE_LOADED_TITLE = "Sample data";

export const HOME_SAMPLE_LOADED_BODY =
  "The rows below are made up, so you can see Home working. Clearing them leaves anything you have added yourself untouched.";

export const HOME_SAMPLE_CLEAR = "Clear the sample";

/**
 * While the generators run, before the first one has been named.
 *
 * This used to be the WHOLE of the filling state: one static sentence on a
 * disabled button for the ten seconds the seven generators take, of which the
 * photo uploads are most. A sentence that never changes is indistinguishable
 * from a surface that has stopped, which is the one reading a local-first
 * product can least afford — it knows exactly how much work is left.
 *
 * So it is now the fallback rather than the state: the run reports its position
 * and the surface says which app it is waiting on. This wording survives for
 * the frame before the first report, and for an app id with no line below.
 */
export const HOME_SAMPLE_FILLING = "Filling your vault with a sample week…";

/**
 * What is being written right now, per app, in the vault's own nouns.
 *
 * PRESENT PARTICIPLE and the app's content, not the app's name: "Adding
 * photographs", not "Seeding photos" — the member is watching their Home fill
 * up, not watching a fixture load. Keyed by gateway app id, so an app that
 * ships a generator later degrades to `HOME_SAMPLE_FILLING` rather than to a
 * blank line.
 */
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

/**
 * The last step, after every generator has returned.
 *
 * It is a real step and it is named as one, because it is the one the member
 * would otherwise experience as the bar reaching the end and nothing happening:
 * the rows are on the gateway and Home reads the local replica, so the tiles
 * cannot fill until the copy catches up. Deliberately unnumbered — it is one
 * act, not an eighth app.
 */
export const HOME_SAMPLE_FILLING_CATCH_UP = "Catching up…";

/** The unit beside the count. "5 of 7 apps" reads as progress through a known
 *  list; a bare "5 of 7" makes the reader guess what is being counted. */
export const HOME_SAMPLE_FILLING_UNIT = "apps";
