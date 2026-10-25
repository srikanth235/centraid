//! Generate the Rust types for both protobuf packages (#1020, D-1020-C5).
//!
//! `protox` parses the `.proto` tree in pure Rust and produces the
//! `FileDescriptorSet`; `prost-build` turns that into Rust. There is
//! deliberately no `protoc` on the path here — the common brief's registry
//! table records that this machine has none, and a build that shells out to a
//! binary nobody installed is a build that works on one laptop.
//!
//! `buf` is NOT in this path either. `buf.gen.yaml` at the repository root is
//! documentation of what the other languages generate; the Rust codegen is this
//! file, so a contributor without `buf` can still build the workspace while
//! `buf lint` / `buf breaking` stay gate steps rather than build steps.

use std::path::PathBuf;

/// Every file in the tree, named rather than globbed: a `.proto` that is not on
/// this list is a file nothing generates from, and a glob would hide that.
/// `tests/tree.rs` asserts the list and the directory agree.
const PROTOS: [&str; 48] = [
    "proto/centraid/core/v1/value.proto",
    "proto/centraid/core/v1/row.proto",
    "proto/centraid/core/v1/command.proto",
    "proto/centraid/core/v1/query.proto",
    "proto/centraid/core/v1/content.proto",
    "proto/centraid/core/v1/change.proto",
    "proto/centraid/core/v1/handshake.proto",
    "proto/centraid/core/v1/error.proto",
    "proto/centraid/core/v1/envelope.proto",
    // Founding a vault over the ABI (#1029 W5, hand-off 1). Its own file rather
    // than an arm on `command.proto`, because founding is the act that writes
    // the rows the command plane's gate order reads.
    "proto/centraid/core/v1/vault.proto",
    // The phone's two flows (#1029 W15): drain, and restore from 24 words,
    // with pairing and the backup status the shell draws beside them. Its own
    // file for the reason `vault.proto` has one — none of the four can be a
    // registered command, and the reasons differ per verb, so they are stated
    // where a shell author reads them.
    "proto/centraid/core/v1/phone.proto",
    // The originals on this phone and the albums whose originals stay (#1029,
    // the photos port). Its own file for `phone.proto`'s reason: the keep list
    // is a fact about the phone's disk and cannot be a registered command.
    "proto/centraid/core/v1/originals.proto",
    // An app's own query, run in the core, and Agenda's four answers (#1046).
    // Two files because the arm is the plane's and the answers are the app's:
    // the next app's queries arrive as its own file and one more arm, and
    // `app_query.proto` is the one both envelopes import.
    "proto/centraid/core/v1/agenda.proto",
    // People's five answers (#1046), the same shape as Agenda's.
    "proto/centraid/core/v1/people.proto",
    // Notes' eight answers (#1046), the same shape as Agenda's.
    "proto/centraid/core/v1/notes.proto",
    // Docs' four answers (#1046), the same shape as Agenda's.
    "proto/centraid/core/v1/docs.proto",
    // Tasks' five answers (#1046), the same shape as Agenda's.
    "proto/centraid/core/v1/tasks.proto",
    // Locker's four answers and its session (#1047, D-5): the queries the
    // phone asks while unlocked, and the one request that loads `K`.
    "proto/centraid/core/v1/locker.proto",
    // The chat's history, as reads (R-CHAT-1): threads, one thread's messages
    // and whether a card's row is still there.
    "proto/centraid/core/v1/chat.proto",
    // Home's search (R-CHROME-6): the powerbox's loader over every domain but
    // Locker, asked from Home. Its own file because Home is not an app.
    "proto/centraid/core/v1/vault_search.proto",
    // A container as a search result (#1097): the one message the four owning
    // apps' own search answers share.
    "proto/centraid/core/v1/container.proto",
    // Photos' own search (#1097, R-1097-25..27): the text and album legs, asked of
    // the full-text door, and the correction.
    "proto/centraid/core/v1/photos.proto",
    // Money's ten answers, its import plan and Home's tile (#1099).
    "proto/centraid/core/v1/money.proto",
    // Health's six answers (#1129): today, a series, the trends, the workouts
    // and one workout, and the follower engine's view of what the vault holds.
    "proto/centraid/core/v1/health.proto",
    "proto/centraid/core/v1/app_query.proto",
    // THE ONE READ AND THE ONE WRITE (#1135): `load(app, query, params)` and
    // `act(app, action, input)`, spoken through each app's manifest.
    "proto/centraid/core/v1/action.proto",
    // THE SCREEN RUNTIME'S WIRE (#1135, lane C2): route stacks, events, view
    // states and effects, spoken through three arms of the one `Envelope`.
    // The route (a leaf, so a view can name one), the shared view vocabulary
    // (a leaf), Agenda's screens, and the runtime's own wire that imports them.
    "proto/centraid/core/v1/route.proto",
    "proto/centraid/core/v1/kit_screens.proto",
    "proto/centraid/core/v1/agenda_screens.proto",
    // Photos' screens (#1135, lane D): the vocabulary every Photos screen shares
    // (the cell, the selection bar, the album sheet), then one file per worker.
    "proto/centraid/core/v1/photos_screens.proto",
    "proto/centraid/core/v1/photos_home_screens.proto",
    "proto/centraid/core/v1/photos_shelf_screens.proto",
    "proto/centraid/core/v1/photos_lightbox_screens.proto",
    "proto/centraid/core/v1/locker_screens.proto",
    "proto/centraid/core/v1/money_screens.proto",
    "proto/centraid/core/v1/docs_screens.proto",
    "proto/centraid/core/v1/health_screens.proto",
    "proto/centraid/core/v1/notes_screens.proto",
    "proto/centraid/core/v1/people_screens.proto",
    // Vault plumbing (#1135, lane H2): the generic secret/core-call effects and
    // the custody, pairing, backup and pass screens that speak them.
    "proto/centraid/core/v1/plumbing_screens.proto",
    "proto/centraid/core/v1/custody_screens.proto",
    "proto/centraid/core/v1/pair_screens.proto",
    "proto/centraid/core/v1/backup_screens.proto",
    "proto/centraid/core/v1/passes_screens.proto",
    // The vaults this phone holds (#1135, lane H2): the `holdings` query's
    // answer, imported by `app_query.proto`.
    "proto/centraid/core/v1/vault_screens.proto",
    "proto/centraid/core/v1/screens.proto",
    // The on-device chat: a session, a question and a stream of events, over
    // reads an app already answers. Its own file because a turn is neither a
    // command nor a page read.
    "proto/centraid/core/v1/assist.proto",
    "proto/centraid/screen/v1/screen.proto",
];

fn main() -> Result<(), Box<dyn std::error::Error>> {
    for proto in PROTOS {
        println!("cargo:rerun-if-changed={proto}");
    }
    // A new file in the tree changes the answer of `tests/tree.rs` even when no
    // listed file changed, so the directory is watched too.
    println!("cargo:rerun-if-changed=proto");

    let descriptors = protox::compile(PROTOS, ["proto"])?;

    let out: PathBuf = std::env::var("OUT_DIR")?.into();
    prost_build::Config::new()
        .out_dir(&out)
        // Boxed where one oneof arm dwarfs its siblings, so a small message
        // does not carry the largest arm's size inline (`large_enum_variant`).
        // Every app screen's `data` arm: the answer is the whole screen, and
        // its siblings (loading, empty, refused) are a line or two each.
        .boxed(".centraid.core.v1.PhotosDuplicatesState.content.data")
        .boxed(".centraid.core.v1.PhotosDuplicateReviewState.content.data")
        .boxed(".centraid.core.v1.PhotosEditorState.content.data")
        .boxed(".centraid.core.v1.PhotosLightboxState.content.photo")
        .boxed(".centraid.core.v1.ViewState.kind.photos_lightbox")
        .boxed(".centraid.core.v1.AgendaHomeState.content.data")
        .boxed(".centraid.core.v1.AgendaEventState.content.data")
        .boxed(".centraid.core.v1.AgendaEditorState.content.data")
        .boxed(".centraid.core.v1.TodoDetailState.content.data")
        .boxed(".centraid.core.v1.BackupHomeState.body.data")
        .boxed(".centraid.core.v1.TodoProjectState.content.data")
        .boxed(".centraid.core.v1.LockerHomeState.content.data")
        .boxed(".centraid.core.v1.LockerItemState.content.data")
        .boxed(".centraid.core.v1.LockerEditorState.content.data")
        .boxed(".centraid.core.v1.LockerExportState.content.data")
        .boxed(".centraid.core.v1.LockerImportState.content.data")
        .boxed(".centraid.core.v1.MoneyHomeState.content.data")
        .boxed(".centraid.core.v1.MoneyTransactionState.content.data")
        .boxed(".centraid.core.v1.MoneyTargetState.content.data")
        .boxed(".centraid.core.v1.MoneyImportState.content.data")
        .boxed(".centraid.core.v1.MoneyCategoriesState.content.data")
        .boxed(".centraid.core.v1.MoneyAccountsState.content.data")
        .boxed(".centraid.core.v1.MoneyRulesState.content.data")
        // Home is by far the largest view state.
        .boxed(".centraid.core.v1.ViewState.kind.agenda_home")
        // Photos' home carries the library, Collections and Search in one state.
        .boxed(".centraid.core.v1.ViewState.kind.photos_home")
        .boxed(".centraid.core.v1.PhotosLibrary.content.data")
        .boxed(".centraid.core.v1.PhotosSearchView.content.hits")
        .boxed(".centraid.core.v1.ViewState.kind.docs_drive")
        .boxed(".centraid.core.v1.ViewState.kind.notes_home")
        .boxed(".centraid.core.v1.ViewState.kind.health_home")
        .boxed(".centraid.core.v1.HealthHomeState.content.data")
        .boxed(".centraid.core.v1.HealthMetricState.content.data")
        .boxed(".centraid.core.v1.HealthWorkoutState.content.data")
        .boxed(".centraid.core.v1.ViewState.kind.people_home")
        .boxed(".centraid.core.v1.ViewState.kind.people_person")
        .boxed(".centraid.core.v1.ViewState.kind.people_editor")
        .boxed(".centraid.core.v1.PeopleHomeState.content.roster")
        .boxed(".centraid.core.v1.PeopleHomeState.content.touch")
        .boxed(".centraid.core.v1.PeoplePersonState.content.data")
        .boxed(".centraid.core.v1.DocsDriveState.content.data")
        .boxed(".centraid.core.v1.DocsDocumentState.content.data")
        .boxed(".centraid.core.v1.Response.kind.app_query")
        // Photos' collections overview holds a cover cell for each shelf and album.
        .boxed(".centraid.core.v1.AppQueryResponse.answer.photos_albums")
        .boxed(".centraid.core.v1.AppQueryResponse.answer.photos_photo")
        .boxed(".centraid.core.v1.AppQueryResponse.answer.photos_shelf")
        .boxed(".centraid.core.v1.PhotosShelfState.content.data")
        .boxed(".centraid.core.v1.PhotosPickerState.content.data")
        .boxed(".centraid.core.v1.PhotosPlacesState.content.data")
        .boxed(".centraid.core.v1.ViewState.kind.photos_shelf")
        .boxed(".centraid.core.v1.ViewState.kind.photos_picker")
        .boxed(".centraid.core.v1.ViewState.kind.photos_places")
        // The one read and the one write (#1135): a request carries a map, and
        // an answer the app's whole typed answer.
        .boxed(".centraid.core.v1.Request.kind.load")
        .boxed(".centraid.core.v1.Request.kind.act")
        .boxed(".centraid.core.v1.Response.kind.load")
        .boxed(".centraid.core.v1.Response.kind.act")
        .boxed(".centraid.core.v1.Request.kind.screen")
        .boxed(".centraid.core.v1.Response.kind.screen")
        .boxed(".centraid.core.v1.Event.kind.screen")
        .boxed(".centraid.core.v1.AppQueryResponse.answer.tasks_task")
        // The event detail carries its calendar row since #1047.
        .boxed(".centraid.core.v1.AppQueryResponse.answer.agenda_event")
        // One Locker item is thirty-one fields and its sidecars (#1047).
        .boxed(".centraid.core.v1.AppQueryResponse.answer.locker_item")
        // An export's file and an import's plan ride the session's answer
        // (#1047 T2); boxed so every other session step stays small.
        .boxed(".centraid.core.v1.LockerSessionResponse.exported")
        .boxed(".centraid.core.v1.LockerSessionResponse.import_plan")
        // Money's screens (#1099): the five whose data arm dwarfs its siblings.
        .boxed(".centraid.screen.v1.MoneyHomeState.content.data")
        .boxed(".centraid.screen.v1.MoneyTransactionState.content.data")
        .boxed(".centraid.screen.v1.MoneyTargetState.content.data")
        .boxed(".centraid.screen.v1.MoneyImportState.content.data")
        .boxed(".centraid.screen.v1.MoneyCategoriesState.content.data")
        .compile_fds(descriptors)?;
    Ok(())
}
