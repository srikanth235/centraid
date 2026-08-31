// THE testID CONTRACT — the mobile app's stable handles for the Maestro layer
// (issue #890 W2).
//
// WHY THIS FILE EXISTS. Before it, exactly one `testID` existed on a shared
// path (`onboarding-connect`) and every other Maestro selector was a copy regex
// or a percentage-coordinate gesture. Both rot on a change that is not a defect:
// `HOME_READY_MARKER` broke when #789 replaced HomeStatusLine's settled-state
// copy, leaving every pairing flow waiting on a string the app no longer
// rendered (#839), and `flows/photos-viewer.mjs` paged the viewer by swiping
// `80%,30% → 20%,30%`, which is correct until a layout moves. A copy edit and a
// layout edit are then indistinguishable from a regression.
//
// THE RULES THIS FILE ENCODES:
//
//  1. AN ID IS A CONTRACT WITH THE TEST LAYER, NOT A STYLE HOOK. Renaming one
//     is a breaking change and must land in the SAME COMMIT as every flow that
//     references it — `scripts/lint-mobile-testids.mjs` fails the PR otherwise,
//     in both directions (a flow naming an id no source applies, and an id
//     declared here that nothing renders).
//
//  2. IDS ARE `kebab-case`, NAMESPACED `<surface>-<thing>` — `home-band`,
//     `photos-grid`, `photos-tile-0`, `notes-row-first`, `docs-breadcrumb`,
//     `locker-gate-submit`. The shape follows `onboarding-connect`, which
//     predates this file and is kept verbatim rather than renamed.
//
//  3. COPY ASSERTIONS SURVIVE WHERE THE COPY *IS* THE CLAIM. This file exists
//     to stop copy being used as a LOCATOR, not to delete copy assertions. A
//     refusal sentence ("Photos cannot reach your camera roll"), a consequence
//     sentence ("Everyone who joins gets the full shared item"), an error
//     explanation, the withheld-count label ("Open Locker, locked") — those ARE
//     the product's promise, and a flow that stops asserting them stops proving
//     anything. The rule is: NAVIGATE by id, ASSERT the sentence.
//
//  4. AN ID IS NOT A SUBSTITUTE FOR AN ACCESSIBLE NAME. Every control tagged
//     here keeps its `accessibilityLabel`; `testID` is additive and invisible to
//     a member. Adding one is never a reason to drop the other.
//
// WHY A TS MODULE RATHER THAN LITERALS IN THE JSX: one spelling, one place to
// grep, and the linter can hold the two ends of the contract against each other
// mechanically. Components reference `TEST_IDS.<surface>.<thing>` (or a prefix
// below); the linter accepts either that accessor or the literal as proof the
// id is applied.

/**
 * Every stable handle, grouped by the surface that renders it. Frozen because a
 * handle mutated at runtime is a selector nobody can trace back to a screen.
 */
export const TEST_IDS = Object.freeze({
  /** The springboard shell: the band, the launcher, the all-apps sheet. */
  home: Object.freeze({
    /** Home's root. The arrival marker, replacing the `HOME_READY_MARKER` copy. */
    screen: "home-screen",
    band: "home-band",
    /** The band's More tab — the one that opens the all-apps sheet. */
    bandMore: "home-band-more",
    grid: "home-grid",
    allApps: "home-all-apps",
    /** The vault lockup, which IS the vault switch. */
    vaultSwitch: "home-vault-switch",
  }),

  /** Ticket-only onboarding (#603). */
  onboarding: Object.freeze({
    /** Predates this file; the spelling is the contract, so it is kept as-is. */
    connect: "onboarding-connect",
    /** "Can't scan? Paste a code instead" — the door to the ticket field. */
    paste: "onboarding-paste",
    ticketField: "onboarding-ticket-field",
    profileName: "onboarding-profile-name",
    profileContinue: "onboarding-profile-continue",
  }),

  settings: Object.freeze({
    screen: "settings-screen",
    /** The first section Settings publishes — arrival without a scroll. */
    appearance: "settings-appearance",
    sharingRow: "settings-sharing-row",
  }),

  /** Settings → Sharing: the seat that REDEEMS an invitation. */
  sharing: Object.freeze({
    redeem: "sharing-redeem",
    redeemField: "sharing-redeem-field",
  }),

  photos: Object.freeze({
    band: "photos-band",
    collections: "photos-collections",
    /** The justified timeline — every surface that draws tiles uses it. */
    grid: "photos-grid",
    select: "photos-select",
    searchField: "photos-search-field",
    /** The refusal takeover; its copy is the claim, its id is the locator. */
    accessPanel: "photos-access-panel",
    accessAsk: "photos-access-ask",
    accessSettings: "photos-access-settings",
    selectionAlbum: "photos-selection-album",
    selectionTrash: "photos-selection-trash",
    viewer: "photos-viewer",
    /**
     * The horizontal pager. THE ANCHOR THAT RETIRES THE COORDINATE SWIPE:
     * `swipe: { from: { id: "photos-viewer-pager" }, direction: LEFT }` instead
     * of `start: "80%,30%"`.
     */
    viewerPager: "photos-viewer-pager",
    viewerPrev: "photos-viewer-prev",
    viewerNext: "photos-viewer-next",
    viewerBack: "photos-viewer-back",
    viewerMore: "photos-viewer-more",
    infoSheet: "photos-info-sheet",
    infoClose: "photos-info-close",
  }),

  docs: Object.freeze({
    band: "docs-band",
    /** The drive's first row — the deterministic "open a document" target. */
    rowFirst: "docs-row-first",
    /** The pushed shelf's back control ("Back to All"). */
    breadcrumb: "docs-breadcrumb",
  }),

  agenda: Object.freeze({
    band: "agenda-band",
    today: "agenda-today",
    newEvent: "agenda-new-event",
    eventBack: "agenda-event-back",
  }),

  notes: Object.freeze({
    band: "notes-band",
    rowFirst: "notes-row-first",
    /**
     * The body preview under the first row. The row and the body are two
     * separate replica reads joined on device, so the preview needs a handle of
     * its own — a dropped join is headings above empty previews.
     */
    rowFirstPreview: "notes-row-first-preview",
    capture: "notes-capture",
    editorClose: "notes-editor-close",
  }),

  tasks: Object.freeze({
    band: "tasks-band",
    /** The one group `todayGroups()` flags for attention — overdue. */
    groupAttention: "tasks-group-attention",
    moveAll: "tasks-move-all",
    capture: "tasks-capture",
  }),

  people: Object.freeze({
    band: "people-band",
    rowFirst: "people-row-first",
  }),

  tally: Object.freeze({
    band: "tally-band",
    /** The group's own life-act that mints an invitation. */
    shareVerb: "tally-share-verb",
  }),

  locker: Object.freeze({
    band: "locker-band",
    /** The unlock/first-run gate. */
    gate: "locker-gate",
    gateField: "locker-gate-field",
    gateSubmit: "locker-gate-submit",
  }),

  places: Object.freeze({
    shelf: "places-shelf",
    mapOpen: "places-map-open",
    map: "places-map",
    /** The resting sentence, replaced by a pressed pin's readout. */
    readout: "places-readout",
  }),

  /**
   * The __DEV__ frame-drop probe (#659 R3c). These two predate this file and are
   * PINNED BY A DOCUMENTED CONTRACT that `flows/scroll-frames.mjs` and
   * `lib/perf/frame-sampler.test.ts` both read — the spellings are kept verbatim
   * because renaming them would silently unarm the sampler.
   */
  perf: Object.freeze({
    sampling: "perf-frame-sampling",
    report: "perf-frame-report",
  }),

  /** Kit surfaces that belong to no one app. */
  shell: Object.freeze({
    /**
     * The anchored menu's dismiss target. It is deliberately outside the modal's
     * accessibility subtree, which is why `flows/photos-viewer.mjs` dismissed it
     * by tapping `10%,50%`; the id is what retires that coordinate.
     */
    menuBackdrop: "shell-menu-backdrop",
    menuCard: "shell-menu-card",
    shareSheet: "shell-share-sheet",
    shareSheetCancel: "shell-share-sheet-cancel",
  }),
});

/**
 * PREFIXES for the handle FAMILIES — the places where one id per element is a
 * list, not a name. A member of a family is `<prefix><key>`; the key is the
 * thing's own stable identity (an app id, a band destination key, a shelf key)
 * or its position in the list.
 *
 * A family is declared here rather than spelled out per member so the linter can
 * resolve `docs-band-folders` without this file having to enumerate every
 * destination every band will ever have.
 */
export const TEST_ID_PREFIXES = Object.freeze({
  /** `home-tile-photos` — the launcher tile, keyed by blueprint app id. */
  homeTile: "home-tile-",
  /** `home-place-settings` — an all-apps place row, keyed by place id. */
  homePlace: "home-place-",
  /**
   * `docs-band-folders`, `tasks-band-upcoming`, … — a band tab keyed by its own
   * destination key, which is what the band model already keys on. The label is
   * copy and moves; the key is the contract.
   */
  band: Object.freeze({
    home: "home-band-",
    photos: "photos-band-",
    docs: "docs-band-",
    agenda: "agenda-band-",
    notes: "notes-band-",
    tasks: "tasks-band-",
    people: "people-band-",
    tally: "tally-band-",
    locker: "locker-band-",
  }),
  /**
   * `photos-tile-0` … — the first `PHOTO_TILE_HANDLES` tiles of the justified
   * grid, by position. BOUNDED ON PURPOSE: the grid is the frame-drop surface
   * (`flows/scroll-frames.mjs`), so the handle map must cost the same whether
   * the vault holds 90 photographs or 90,000.
   */
  photosTile: "photos-tile-",
  /** `photos-shelf-places` — a Collections shelf heading, by shelf key. */
  photosShelf: "photos-shelf-",
  /** `photos-viewer-action-info` — a viewer toolbar act, by action id. */
  photosViewerAction: "photos-viewer-action-",
  /** `tasks-row-3` — a row of the board's flattened list, headers included. */
  tasksRow: "tasks-row-",
  /** `places-pin-0` — a map pin, by position in the plotted set. */
  placesPin: "places-pin-",
  /** `places-card-0` — a shelf card, by position. */
  placesCard: "places-card-",
});

/**
 * How many leading grid tiles carry a positional handle. Four is enough to open
 * a photograph, page past it, and come back — and small enough that the lookup
 * the timeline builds is constant work on a 90,000-asset library.
 */
export const PHOTO_TILE_HANDLES = 4;
