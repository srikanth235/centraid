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
const PROTOS: [&str; 25] = [
    "proto/centraid/core/v1/value.proto",
    "proto/centraid/core/v1/row.proto",
    "proto/centraid/core/v1/command.proto",
    "proto/centraid/core/v1/query.proto",
    "proto/centraid/core/v1/content.proto",
    "proto/centraid/core/v1/change.proto",
    "proto/centraid/core/v1/handshake.proto",
    "proto/centraid/core/v1/pair.proto",
    "proto/centraid/core/v1/admin.proto",
    "proto/centraid/core/v1/error.proto",
    "proto/centraid/core/v1/envelope.proto",
    // The gateway protocol (#1029 §3). It lives in `centraid.core.v1` rather
    // than in a package of its own because core.v1's promise IS this promise —
    // "a gateway's commitment to seats that update on their own schedule" — and
    // a third package would need its own `buf breaking` category in `buf.yaml`
    // to say the same thing twice.
    "proto/centraid/core/v1/gateway.proto",
    "proto/centraid/core/v1/backup.proto",
    "proto/centraid/core/v1/lease.proto",
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
    // Tally's ten answers (#1046), the same shape as Agenda's.
    "proto/centraid/core/v1/tally.proto",
    // Tasks' five answers (#1046), the same shape as Agenda's.
    "proto/centraid/core/v1/tasks.proto",
    "proto/centraid/core/v1/app_query.proto",
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
        .boxed(".centraid.screen.v1.PhotoLightboxState.content.detail")
        .boxed(".centraid.screen.v1.PhotoLightboxEvent.kind.data")
        // Every app screen's `data` arm: the answer is the whole screen, and
        // its siblings (loading, empty, refused) are a line or two each.
        .boxed(".centraid.screen.v1.AgendaEventState.content.data")
        .boxed(".centraid.screen.v1.AgendaEditorState.content.data")
        .boxed(".centraid.screen.v1.PeopleHomeData.surface.touch")
        .boxed(".centraid.screen.v1.PeopleHomeState.content.data")
        .boxed(".centraid.screen.v1.PeopleHomeEvent.kind.data")
        .boxed(".centraid.screen.v1.PeoplePersonState.content.data")
        .boxed(".centraid.screen.v1.PeoplePersonEvent.kind.data")
        .boxed(".centraid.screen.v1.TasksDetailState.content.data")
        .boxed(".centraid.screen.v1.DocsDriveEvent.kind.data")
        .boxed(".centraid.screen.v1.DocsDocumentState.content.data")
        .boxed(".centraid.screen.v1.DocsDocumentEvent.kind.data")
        .boxed(".centraid.screen.v1.TallyHomeState.content.data")
        .boxed(".centraid.screen.v1.TallyGroupState.content.data")
        .boxed(".centraid.screen.v1.TallyFriendState.content.data")
        .boxed(".centraid.screen.v1.TallyExpenseState.content.data")
        .boxed(".centraid.screen.v1.TallyEditorState.content.data")
        .boxed(".centraid.core.v1.Response.kind.app_query")
        .boxed(".centraid.core.v1.AppQueryResponse.answer.tasks_task")
        .compile_fds(descriptors)?;
    Ok(())
}
