// Home's cross-surface copy (#708, section A).
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

/** First run — the vault has no content ANYWHERE. Verbatim from the v4 Binding
 *  Layer handoff (design_handoff_photos/…v4.dc.html:5700, `frTitle`). */
export const HOME_FIRST_RUN_TITLE = "Nothing in here yet";

/** The body under it. One sentence about what Home becomes; custody is stated
 *  where imports are decided, not here (#805). */
export const HOME_FIRST_RUN_BODY =
  "Bring your photographs and documents in and this becomes the front of your own archive.";

/**
 * Day one's three buttons, verbatim from the handoff (:983–990). One filled —
 * the vault's own offer — flanked by the two outlined moves the body
 * paragraph promises ("bring in your own"). Deliberately its own trio rather
 * than a slice of `HOME_FIRST_MOVE_COPY` below: the quiet start band reuses
 * that catalog's verb-first phrasing across up to nine apps, but day one is a
 * themed page with exactly three fixed offers, and "Bring in photographs" /
 * "Bring in documents" read as a page's own copy, not a band row's.
 */
export const HOME_DAY_ONE_SEED_LABEL = "Fill it with sample content";
export const HOME_DAY_ONE_PHOTOS_LABEL = "Bring in photographs";
export const HOME_DAY_ONE_DOCS_LABEL = "Bring in documents";

/**
 * Day one's mono foot, real counts substituted into the handoff's own template
 * (`frFoot`, :5706 — the prototype's static "8 apps installed · 0 things …").
 * `appsInstalled` and `things` are real reads (`items.length` / `countThings`
 * in Home.tsx), never the prototype's fixture numbers.
 */
export function homeDayOneFoot(appsInstalled: number, things: number): string {
  return `${appsInstalled} apps installed · ${things} things · sample content can be removed in one action`;
}

// The surviving load-bearing offline copy is `OFFLINE_COMMIT_REASON` in
// react/shell/commitAvailability.tsx, which the UI surfaces contextually
// during write attempts rather than as a permanent banner on the vault index.

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
  "Invented content in the real structure — nothing leaves this device, and one tap clears it.";

/** While the sample is loaded. Present tense, first word does the work. */
export const HOME_SAMPLE_LOADED_TITLE = "Sample data";

export const HOME_SAMPLE_LOADED_BODY =
  "The rows below are made up; clearing them leaves your own additions untouched.";

export const HOME_SAMPLE_CLEAR = "Clear the sample";

/**
 * While the generators run, before the first one has been named.
 *
 * The FALLBACK, not the state: a sentence that never changes over the ten
 * seconds the seven generators take is indistinguishable from a surface that
 * has stopped, which is the one reading a local-first product can least
 * afford — it knows exactly how much work is left. So the run reports its
 * position and the surface says which app it is waiting on; this wording
 * covers the frame before the first report, and an app id with no line below.
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
