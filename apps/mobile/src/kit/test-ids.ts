export const TEST_IDS = Object.freeze({
  home: Object.freeze({
    screen: "home-screen",
    band: "home-band",
    bandMore: "home-band-more",
    grid: "home-grid",
    allApps: "home-all-apps",
    vaultSwitch: "home-vault-switch",
  }),

  onboarding: Object.freeze({
    connect: "onboarding-connect",
    paste: "onboarding-paste",
    ticketField: "onboarding-ticket-field",
  }),

  settings: Object.freeze({
    screen: "settings-screen",
    appearance: "settings-appearance",
    sharingRow: "settings-sharing-row",
  }),

  sharing: Object.freeze({
    screen: "sharing-screen",
    people: "sharing-people",
  }),

  photos: Object.freeze({
    band: "photos-band",
    collections: "photos-collections",
    grid: "photos-grid",
    select: "photos-select",
    searchField: "photos-search-field",
    accessPanel: "photos-access-panel",
    accessAsk: "photos-access-ask",
    accessSettings: "photos-access-settings",
    selectionAlbum: "photos-selection-album",
    selectionTrash: "photos-selection-trash",
    viewer: "photos-viewer",
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
    rowFirst: "docs-row-first",
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
    rowFirstPreview: "notes-row-first-preview",
    capture: "notes-capture",
    editorClose: "notes-editor-close",
  }),

  tasks: Object.freeze({
    band: "tasks-band",
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
    addCommit: "tally-add-commit",
    shareVerb: "tally-share-verb",
  }),

  locker: Object.freeze({
    band: "locker-band",
    gate: "locker-gate",
    gateField: "locker-gate-field",
    gateSubmit: "locker-gate-submit",
  }),

  places: Object.freeze({
    shelf: "places-shelf",
    mapOpen: "places-map-open",
    map: "places-map",
    readout: "places-readout",
  }),

  perf: Object.freeze({
    sampling: "perf-frame-sampling",
    report: "perf-frame-report",
  }),

  shell: Object.freeze({
    menuBackdrop: "shell-menu-backdrop",
    menuCard: "shell-menu-card",
    shareSheet: "shell-share-sheet",
    shareSheetCancel: "shell-share-sheet-cancel",
  }),
});

export const TEST_ID_PREFIXES = Object.freeze({
  homeTile: "home-tile-",
  homePlace: "home-place-",
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
  photosTile: "photos-tile-",
  photosShelf: "photos-shelf-",
  photosViewerAction: "photos-viewer-action-",
  tasksRow: "tasks-row-",
  placesPin: "places-pin-",
  placesCard: "places-card-",
});

export const PHOTO_TILE_HANDLES = 4;
