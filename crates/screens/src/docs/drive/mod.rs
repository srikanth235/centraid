//! DOCS' DRIVE (`docs.drive`, #1046): All · Folders · Starred, with Recently
//! added from More, search as the room's bar (R-CHROME-2), the filters and the
//! sort as the room's chip row (R-CHROME-3), a folder's own page, and every
//! write a row offers. One screen, the shelf a parameter (law 2): the tab's
//! root and each folder page pushed over it are this machine on two routes.
//!
//! ## The band
//!
//! All · Folders · Starred · More. Shared left with the sharing plane (#1029),
//! "Coming due" has no data plane in this build (nothing reads obligations out
//! of a document), and search is a field on the current surface, never a tab.
//!
//! ## What reads
//!
//! The shelf, the folder, the three filters and the order are the core's
//! REQUEST (`docs.drive`), so changing any of them reads again. A term reads
//! `docs.search` instead; the folder rail and counts are kept from the last
//! drive answer. Grid or list is local and reads nothing. Reads are
//! synchronous, so there is no read in flight to queue behind.
//!
//! ## Writes
//!
//! Star, move, labels, trash (behind a confirm) and a new folder are one write
//! each, answered at once; a refusal keeps the rows and says so. Rename is inline
//! and autosaves ([`Rename`]). Nothing is patched locally: the next load shows
//! what committed. The Add sheet's Upload, Scan and Text rows are the ingest
//! ([`ingest`]); whether they can be offered is the OS grants the shell reports
//! (law 4).
//!
//! ## Views decide nothing
//!
//! The band, the pills, the sheets, the empty choice, the head's subtitle and
//! every label are made again on every view.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::docs_drive_event::Kind as D;
use wire::screen_event::Kind as E;

use super::fold::{KEY_LABELS, KEY_MOVE, KEY_RENAME, KEY_STAR, KEY_TRASH, KEY_UNSTAR};
use super::folders::TOP_LEVEL;
use super::rename::Rename;
use super::{Phase, refusal};
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::docs as words;

mod ingest;
mod query;
mod sheets;
mod view;

pub use ingest::UNAVAILABLE;
use ingest::{Ingest, Kind};
use query::Query;
use sheets::Sheet;

/// The Add sheet's, More's and the followed list's row keys.
pub const KEY_RECENT: &str = "recent";
pub const KEY_TRASH_SHELF: &str = "trash_shelf";
pub const KEY_UPLOAD: &str = "upload";
pub const KEY_SCAN: &str = "scan";
pub const KEY_TEXT: &str = "text";
pub const KEY_NEW_FOLDER: &str = "new_folder";
pub const KEY_FOLLOW_FOLDER: &str = "follow_folder";
pub const KEY_FOLLOWED: &str = "followed";
pub const KEY_STOP_PREFIX: &str = "stop:";

pub const BAND_ALL: &str = "all";
pub const BAND_FOLDERS: &str = "folders";
pub const BAND_STARRED: &str = "starred";
pub const BAND_MORE: &str = "more";

/// `docs.search`'s own ceiling.
const SEARCH_LIMIT: u32 = 100;

/// What a shelf read held: the rows, and what only a search answer adds.
#[derive(Clone, Debug)]
struct Held {
    search: bool,
    rows: Vec<wire::DocsDocumentRow>,
    today: String,
    truncated: bool,
    /// A search answer's corrected words (#1097); empty for an exact answer.
    corrected: String,
    /// A search answer's folders whose name matched.
    containers: Vec<wire::ContainerHit>,
}

/// The folder tree, the labels and the counts, from the last drive answer. Kept
/// apart from the rows so a search answer (which has none) keeps them.
#[derive(Clone, Debug, Default)]
pub(super) struct Rail {
    folders: Vec<wire::DocsFolder>,
    labels: Vec<String>,
    all_count: u32,
    unfiled_count: u32,
    starred_count: u32,
    trash_count: u32,
}

#[derive(Clone, Debug, Default)]
struct Search {
    open: bool,
    term: String,
}

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::DocsDrive(args)) = &route.args else {
        return None;
    };
    let destination = match args.destination() {
        wire::DocsDestination::Unspecified => wire::DocsDestination::All,
        other => other,
    };
    let folder = destination == wire::DocsDestination::Folders && !args.folder_id.is_empty();
    Some(Box::new(Drive {
        destination,
        folder_id: if folder {
            args.folder_id.clone()
        } else {
            String::new()
        },
        folder_name: if folder {
            args.folder_name.clone()
        } else {
            String::new()
        },
        parent: if folder {
            args.parent.clone()
        } else {
            String::new()
        },
        query: Query::default(),
        grid: false,
        search: Search::default(),
        phase: Phase::Loading,
        rail: None,
        sheet: Sheet::None,
        status: None,
        asking: None,
        rename: None,
        camera: wire::DocsPermission::NotAsked,
        files: wire::DocsPermission::NotAsked,
        followed: Vec::new(),
        ingest: Ingest::default(),
    }))
}

struct Drive {
    destination: wire::DocsDestination,
    /// FOLDERS only: the folder open, empty for the drive's top level; its name
    /// rides along so the head has words before the read lands.
    folder_id: String,
    folder_name: String,
    /// A folder page's back word: the page it was pushed from.
    parent: String,
    query: Query,
    grid: bool,
    search: Search,
    phase: Phase<Held>,
    rail: Option<Rail>,
    sheet: Sheet,
    /// A refused write's sentence, over the rows.
    status: Option<wire::StatusLine>,
    /// The document a trash confirm asks about.
    asking: Option<String>,
    rename: Option<Rename>,
    camera: wire::DocsPermission,
    files: wire::DocsPermission,
    followed: Vec<wire::DocsFollowed>,
    ingest: Ingest,
}

impl Drive {
    /// The term the drive is searching, or `None` when it reads its shelf.
    fn active_term(&self) -> Option<String> {
        let term = self.search.term.trim();
        (self.search.open && !term.is_empty()).then(|| term.to_owned())
    }

    /// Recently added is a window, not a filter: it carries none.
    fn filtering(&self) -> bool {
        self.destination != wire::DocsDestination::Recent
    }

    // -----------------------------------------------------------------------
    // Reads
    // -----------------------------------------------------------------------

    fn reload(&mut self, ctx: &Ctx) {
        if let Some(term) = self.active_term() {
            let mut request: wire::LoadRequest = load::docs::Search { term }.into();
            request.limit = SEARCH_LIMIT;
            let reading = read::read(ctx, request, |answer| match answer {
                Answer::DocsSearch(search) => Some(search),
                _ => None,
            });
            self.phase = match reading {
                Reading::Data(search) => Phase::Ready(Held {
                    search: true,
                    rows: search.documents,
                    today: search.today,
                    truncated: false,
                    corrected: search.corrected,
                    containers: search.containers,
                }),
                Reading::Denied(denial) => Phase::Denied(denial),
                Reading::Failed => Phase::Failed,
            };
            return;
        }
        let reading = read::read(ctx, self.drive_request(), |answer| match answer {
            Answer::DocsDrive(drive) => Some(drive),
            _ => None,
        });
        self.phase = match reading {
            Reading::Data(drive) => {
                self.rail = Some(Rail {
                    folders: drive.folders,
                    labels: drive.labels,
                    all_count: drive.all_count,
                    unfiled_count: drive.unfiled_count,
                    starred_count: drive.starred_count,
                    trash_count: drive.trash_count,
                });
                Phase::Ready(Held {
                    search: false,
                    rows: drive.documents,
                    today: drive.today,
                    truncated: drive.truncated,
                    corrected: String::new(),
                    containers: Vec::new(),
                })
            }
            Reading::Denied(denial) => Phase::Denied(denial),
            Reading::Failed => Phase::Failed,
        };
    }

    /// The shelf as the core's request.
    fn drive_request(&self) -> load::docs::Drive {
        use wire::DocsDestination as Dest;
        let shelf = match self.destination {
            Dest::Folders => "folder",
            Dest::Starred => "starred",
            Dest::Recent => "recent",
            _ => "all",
        };
        if self.destination == Dest::Recent {
            return load::docs::Drive {
                shelf: Some(shelf.to_owned()),
                ..Default::default()
            };
        }
        load::docs::Drive {
            shelf: Some(shelf.to_owned()),
            folder_id: (self.destination == Dest::Folders).then(|| self.folder_id.clone()),
            r#type: self.query.type_param(),
            modified: self.query.modified_param(),
            label: Some(self.query.label.clone()).filter(|label| !label.is_empty()),
            sort: Some(self.query.sort_param().to_owned()),
            ascending: Some(i64::from(self.query.ascending)),
            ..Default::default()
        }
    }

    fn rows(&self) -> &[wire::DocsDocumentRow] {
        self.phase.data().map_or(&[], |held| held.rows.as_slice())
    }

    fn row(&self, document_id: &str) -> Option<&wire::DocsDocumentRow> {
        self.rows()
            .iter()
            .find(|row| row.document_id == document_id)
    }

    /// The title this page says, which is a pushed page's back word.
    fn title(&self, ctx: &Ctx) -> String {
        view::title(self, ctx.locale())
    }

    // -----------------------------------------------------------------------
    // Writes
    // -----------------------------------------------------------------------

    /// One write under a key of its own: a refusal is the status line, and the
    /// page is read again either way.
    fn write(&mut self, ctx: &Ctx, request: impl Into<wire::ActRequest>, subject: &str) -> bool {
        let request: wire::ActRequest = request.into();
        self.status = None;
        let key = kit_act::key(&[&request.action, subject], kit_act::fresh());
        let settled = kit_act::act(ctx, request, &key);
        if !settled.committed {
            self.status = Some(refusal(settled.refusal));
        }
        self.reload(ctx);
        settled.committed
    }

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    fn event(&mut self, event: wire::DocsDriveEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(D::Refreshed(_)) => self.reload(ctx),
            Some(D::Band(picked)) => self.band(ctx, &picked.key),
            Some(D::SearchOpened(_)) => self.search.open = true,
            Some(D::SearchTerm(typed)) => {
                self.search.open = true;
                self.search.term = typed.term;
                self.reload(ctx);
            }
            Some(D::SearchClosed(_)) => {
                let was = self.search.open || !self.search.term.is_empty();
                self.search = Search::default();
                if was {
                    self.reload(ctx);
                }
            }
            Some(D::LayoutToggled(_)) => self.grid = !self.grid,
            Some(D::SheetOpened(opened)) => self.open_sheet(opened.kind()),
            Some(D::SheetClosed(_)) => self.sheet = Sheet::None,
            Some(D::Choice(picked)) => self.choice(ctx, &picked.key),
            Some(D::FiltersCleared(_)) => {
                self.query.clear_filters();
                self.sheet = Sheet::None;
                self.reload(ctx);
            }
            Some(D::RowMenu(opened)) => {
                if self.row(&opened.document_id).is_some() {
                    self.sheet = Sheet::RowMenu(opened.document_id);
                }
            }
            Some(D::Action(picked)) => return self.action(ctx, &picked.key),
            Some(D::RenameEdited(edited)) => {
                if let Some(rename) = self.rename.as_mut() {
                    rename.edit(ctx, edited.title);
                }
            }
            Some(D::RenameClosed(_)) => self.close_rename(ctx),
            Some(D::LabelAdded(added)) => self.label_added(ctx, &added.label),
            Some(D::LabelRemoved(removed)) => self.label_removed(ctx, &removed.tag_id),
            Some(D::LabelDraft(typed)) => {
                if let Sheet::Labels { draft, .. } = &mut self.sheet {
                    *draft = typed.text;
                }
            }
            Some(D::FolderName(typed)) => {
                if let Sheet::NewFolder(name) = &mut self.sheet {
                    *name = typed.name;
                }
            }
            Some(D::FolderCreated(_)) => self.folder_created(ctx),
            Some(D::Confirmed(_)) => {
                if let Some(id) = self.asking.take() {
                    self.write(
                        ctx,
                        act::docs::Trash {
                            document_id: id.clone(),
                        },
                        &id,
                    );
                }
            }
            Some(D::Dismissed(_)) => self.asking = None,
            Some(D::Permission(changed)) => self.permission(&changed),
            Some(D::FollowedChanged(changed)) => self.followed = changed.followed,
            Some(D::IngestRetried(_)) => {
                let effects = self.ingest.retry(ctx);
                self.reload(ctx);
                return effects;
            }
            Some(D::IngestDismissed(_)) => self.ingest.dismiss(),
            None => {}
        }
        Vec::new()
    }

    fn permission(&mut self, changed: &wire::docs_drive_event::PermissionChanged) {
        use wire::docs_drive_event::permission_changed::Surface;
        match changed.surface() {
            Surface::Camera => self.camera = changed.permission(),
            Surface::Files => self.files = changed.permission(),
            Surface::Unspecified => {}
        }
    }

    fn band(&mut self, ctx: &Ctx, key: &str) {
        use wire::DocsDestination as Dest;
        if key == BAND_MORE {
            self.sheet = Sheet::More;
            return;
        }
        let to = match key {
            BAND_ALL => Dest::All,
            BAND_FOLDERS => Dest::Folders,
            BAND_STARRED => Dest::Starred,
            _ => return,
        };
        self.go_to(ctx, to);
    }

    /// A DESTINATION CHANGE (law 2): the same one is nothing; another closes
    /// search, lands at the top level and reads. Folders' tab is always the top
    /// level; a folder inside it is a pushed page (a row's route).
    fn go_to(&mut self, ctx: &Ctx, to: wire::DocsDestination) {
        self.sheet = Sheet::None;
        if self.destination == to && self.folder_id.is_empty() {
            return;
        }
        self.destination = to;
        self.folder_id.clear();
        self.folder_name.clear();
        self.search = Search::default();
        self.reload(ctx);
    }

    fn open_sheet(&mut self, kind: wire::docs_sheet::Kind) {
        use wire::docs_sheet::Kind as K;
        self.sheet = match kind {
            K::More => Sheet::More,
            K::Add => Sheet::Add,
            K::Type => Sheet::Type,
            K::Modified => Sheet::Modified,
            K::Label => Sheet::Label,
            K::Sort => Sheet::Sort,
            K::NewFolder => Sheet::NewFolder(String::new()),
            K::Followed => Sheet::Followed,
            // A row's menu, its move and its labels need the row: `RowMenu`.
            _ => Sheet::None,
        };
    }

    fn choice(&mut self, ctx: &Ctx, key: &str) {
        let sheet = std::mem::replace(&mut self.sheet, Sheet::None);
        match sheet {
            Sheet::Type => {
                self.query
                    .pick_type(if key == query::ANY { "" } else { key });
                self.reload(ctx);
            }
            Sheet::Modified => {
                self.query
                    .pick_modified(if key == query::ANY { "" } else { key });
                self.reload(ctx);
            }
            Sheet::Label => {
                self.query.label = if key == query::ANY {
                    String::new()
                } else {
                    key.to_owned()
                };
                self.reload(ctx);
            }
            Sheet::Sort => {
                if self.query.pick_sort(key) {
                    self.reload(ctx);
                } else {
                    self.sheet = Sheet::Sort;
                }
            }
            Sheet::Move(document_id) => {
                let Some(current) = self.row(&document_id).map(|row| row.folder_id.clone()) else {
                    return;
                };
                let folder_id = if key == TOP_LEVEL { "" } else { key };
                // Where it already is: nothing to write.
                if folder_id != current {
                    self.write(
                        ctx,
                        act::docs::Move {
                            document_id: document_id.clone(),
                            folder_id: Some(folder_id.to_owned()).filter(|id| !id.is_empty()),
                        },
                        &format!("{document_id}:{key}"),
                    );
                }
            }
            other => self.sheet = other,
        }
    }

    fn action(&mut self, ctx: &Ctx, key: &str) -> Vec<wire::Effect> {
        match self.sheet.clone() {
            Sheet::More => match key {
                KEY_RECENT => self.go_to(ctx, wire::DocsDestination::Recent),
                KEY_FOLLOWED => self.sheet = Sheet::Followed,
                // `trash_shelf` is a route the shell pushes; the sheet goes.
                _ => self.sheet = Sheet::None,
            },
            Sheet::Add => return self.add(ctx, key),
            Sheet::RowMenu(document_id) => self.row_action(ctx, &document_id, key),
            Sheet::Followed => {
                self.sheet = Sheet::None;
                if let Some(origin) = key.strip_prefix(KEY_STOP_PREFIX).filter(|o| !o.is_empty()) {
                    // The shell forgets its access and tells the core to forget
                    // the folder's links; every document stays.
                    self.followed.retain(|folder| folder.origin_id != origin);
                    return vec![wire::Effect {
                        kind: Some(wire::effect::Kind::StopFollowing(wire::StopFollowing {
                            origin: origin.to_owned(),
                        })),
                    }];
                }
            }
            _ => {}
        }
        Vec::new()
    }

    /// The Add sheet's row: a capture is the ingest's, a folder is a sheet.
    fn add(&mut self, ctx: &Ctx, key: &str) -> Vec<wire::Effect> {
        let kind = match key {
            KEY_UPLOAD => Kind::Upload,
            KEY_SCAN => Kind::Scan,
            KEY_TEXT => Kind::Text,
            KEY_NEW_FOLDER => {
                self.sheet = Sheet::NewFolder(String::new());
                return Vec::new();
            }
            KEY_FOLLOW_FOLDER => {
                self.sheet = Sheet::None;
                return vec![wire::Effect {
                    kind: Some(wire::effect::Kind::FollowFolder(wire::FollowFolder {})),
                }];
            }
            _ => {
                self.sheet = Sheet::None;
                return Vec::new();
            }
        };
        self.sheet = Sheet::None;
        let into = self.new_item_folder();
        let parent = self.title(ctx);
        let effects = self.ingest.request(ctx, kind, &into, &parent);
        // A filed document is on the shelf now.
        self.reload(ctx);
        effects
    }

    /// A new document or folder lands inside the folder open, else at the top
    /// level.
    fn new_item_folder(&self) -> String {
        if self.destination == wire::DocsDestination::Folders {
            self.folder_id.clone()
        } else {
            String::new()
        }
    }

    fn row_action(&mut self, ctx: &Ctx, document_id: &str, key: &str) {
        let Some(row) = self.row(document_id).cloned() else {
            self.sheet = Sheet::None;
            return;
        };
        match key {
            KEY_STAR => {
                self.sheet = Sheet::None;
                self.write(
                    ctx,
                    act::docs::Star {
                        document_id: document_id.to_owned(),
                    },
                    document_id,
                );
            }
            KEY_UNSTAR => {
                self.sheet = Sheet::None;
                self.write(
                    ctx,
                    act::docs::Unstar {
                        document_id: document_id.to_owned(),
                    },
                    document_id,
                );
            }
            KEY_RENAME => {
                self.sheet = Sheet::None;
                // One rename at a time: the open one is saved first, and one
                // that cannot be (a refusal) stays.
                if self.rename.is_some() {
                    self.close_rename(ctx);
                    if self.rename.is_some() {
                        return;
                    }
                }
                self.rename = Some(Rename::open(document_id, &row.title));
            }
            KEY_MOVE => self.sheet = Sheet::Move(document_id.to_owned()),
            KEY_LABELS => {
                self.sheet = Sheet::Labels {
                    document_id: document_id.to_owned(),
                    draft: String::new(),
                };
            }
            KEY_TRASH => {
                self.sheet = Sheet::None;
                self.asking = Some(document_id.to_owned());
            }
            _ => {}
        }
    }

    fn label_added(&mut self, ctx: &Ctx, raw: &str) {
        let Sheet::Labels { document_id, .. } = self.sheet.clone() else {
            return;
        };
        let label = raw.trim().to_owned();
        let Some(row) = self.row(&document_id) else {
            return;
        };
        let known = row.labels.iter().any(|chip| chip.label == label);
        if let Sheet::Labels { draft, .. } = &mut self.sheet {
            draft.clear();
        }
        if label.is_empty() || known {
            return;
        }
        self.write(
            ctx,
            act::docs::Tag {
                document_id: document_id.clone(),
                label: label.clone(),
            },
            &format!("{document_id}:{label}"),
        );
    }

    fn label_removed(&mut self, ctx: &Ctx, tag_id: &str) {
        let Sheet::Labels { document_id, .. } = self.sheet.clone() else {
            return;
        };
        // The vault removes a label by its words: the row's label this tag stands for.
        let Some(label) = self
            .row(&document_id)
            .and_then(|row| row.labels.iter().find(|chip| chip.tag_id == tag_id))
            .map(|chip| chip.label.clone())
        else {
            return;
        };
        self.write(
            ctx,
            act::docs::Untag {
                document_id: document_id.clone(),
                label: label.clone(),
            },
            &format!("{document_id}:{label}"),
        );
    }

    fn folder_created(&mut self, ctx: &Ctx) {
        let Sheet::NewFolder(name) = self.sheet.clone() else {
            return;
        };
        let name = name.trim().to_owned();
        if name.is_empty() {
            return;
        }
        self.sheet = Sheet::None;
        let parent = Some(self.new_item_folder()).filter(|parent| !parent.is_empty());
        self.write(
            ctx,
            act::docs::CreateFolder {
                title: name.clone(),
                parent,
                ..Default::default()
            },
            &name,
        );
    }

    /// Done, or focus left the field: save now (close = done). A refusal keeps
    /// the field open with the sentence over the words.
    fn close_rename(&mut self, ctx: &Ctx) {
        if self.rename.as_mut().is_some_and(|rename| rename.close(ctx)) {
            self.rename = None;
            self.reload(ctx);
        }
    }
}

impl Screen for Drive {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                self.reload(ctx);
            }
            Some(E::TimerFired(fired)) => {
                if let Some(rename) = self.rename.as_mut() {
                    rename.fired(ctx, &fired.timer);
                }
            }
            // CLOSE = DONE: whatever is typed is saved.
            Some(E::Left(_)) => {
                if let Some(rename) = self.rename.as_mut() {
                    let _ = rename.close(ctx);
                }
            }
            Some(E::EffectResult(result)) => return self.effect_result(result, ctx),
            Some(E::DocsDrive(event)) => return self.event(event, ctx),
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        view::state(self, ctx)
    }
}

impl Drive {
    /// An answer to an effect: the ingest's, else the folder follow's.
    fn effect_result(&mut self, result: wire::EffectResult, ctx: &Ctx) -> Vec<wire::Effect> {
        use wire::effect_result::Outcome as O;
        let Some(outcome) = result.outcome else {
            return Vec::new();
        };
        if let Some(effects) = self.ingest.result(ctx, &outcome) {
            self.reload(ctx);
            return effects;
        }
        match outcome {
            O::FolderFollowed(followed) => {
                if !self.followed.iter().any(|f| f.origin_id == followed.origin) {
                    self.followed.push(wire::DocsFollowed {
                        origin_id: followed.origin,
                        name: followed.name,
                        documents: 0,
                    });
                }
            }
            O::Failed(_) => {
                self.status = Some(refusal(words::follow_failed(ctx.locale())));
            }
            _ => {}
        }
        Vec::new()
    }
}
