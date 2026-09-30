//! THE EDITOR CONTRACT — lane E's screen fixtures, decoded and answered
//! (#1020, D-1020-N5).
//!
//! `contracts/screens/notes/*.bin` are `centraid.screen.v1.NotesEditorState`
//! messages: one `.textproto` a human edits and one `.bin` both languages
//! decode. Kotlin reads them in `mobile/shared`'s `jvmTest` and Swift in
//! `mobile/iosApp/Tests`; **this suite is the third reader, and it is the one
//! that checks the fixtures against the HANDLER rather than against a renderer.**
//! A screen contract nothing on the data side answers is a contract about a
//! shape, not about an app.
//!
//! ## The four cases, and the one distinction they exist for
//!
//! | Fixture | What the editor shows | What the handler owes it |
//! |---|---|---|
//! | `loading` | a skeleton, no draft | nothing yet: the read has not happened |
//! | `draft-dirty` | the member's words | `load_note`'s `body` and `format`, verbatim |
//! | `read-refused` | the ask, INSTEAD of the editor | `load_note`'s denial |
//! | `save-refused` | the member's words AND a sentence | `load_note`'s `body` again — a failed SAVE is not a failed READ |
//!
//! The last row is the reason both refusal fixtures exist. `read-refused`
//! carries `failure` and no `draft`, because the body never arrived;
//! `save-refused` carries the `draft` with a `save_failure` inside it, because
//! "an editor that swapped the member's words for an error message would have
//! thrown away the only copy". A handler that answered a denial by clearing the
//! body would satisfy the first fixture and break the second.

use centraid_api_proto::screen_v1::{NoteDraft, NotesEditorState, notes_editor_state};
use centraid_apps_kit::contract_vault::open_contract_vault;
use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::fixtures::{NOTES_DEMO_OWNER, seed_owner_party};
use centraid_apps_kit::page::{Page, PageRequest};
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_kit::row::Row;
use centraid_apps_kit::statement::PageQuery;
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_notes::queries::load_note;
use prost::Message as _;

const NOW: &str = "2099-06-01";

fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .to_path_buf()
}

fn fixture(case: &str) -> NotesEditorState {
    let path = root()
        .join("contracts/screens/notes")
        .join(format!("{case}.bin"));
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|error| panic!("{} is not readable: {error}", path.display()));
    NotesEditorState::decode(bytes.as_slice())
        .unwrap_or_else(|error| panic!("{} is not a NotesEditorState: {error}", path.display()))
}

fn draft_of(state: &NotesEditorState) -> Option<&NoteDraft> {
    match state.content.as_ref()? {
        notes_editor_state::Content::Draft(draft) => Some(draft),
        _ => None,
    }
}

/// The format the proto names, as the vault spells it.
fn format_name(draft: &NoteDraft) -> &'static str {
    match draft.format() {
        centraid_api_proto::screen_v1::note_draft::Format::Markdown => "markdown",
        centraid_api_proto::screen_v1::note_draft::Format::Html => "html",
        centraid_api_proto::screen_v1::note_draft::Format::Plain => "plain",
        centraid_api_proto::screen_v1::note_draft::Format::Unspecified => "plain",
    }
}

/// A DOOR THAT REFUSES. The consent denial, as the app sees it: a
/// [`KitError::Door`], which every query folds onto its own payload.
struct RefusingDoor;

impl PageDoor for RefusingDoor {
    fn page(&self, _query: &PageQuery, _request: &PageRequest) -> KitResult<Page<Row>> {
        Err(KitError::Door(
            "no standing answer covers read of knowledge.note".to_owned(),
        ))
    }
}

/// A vault holding exactly the note the `draft-dirty` fixture is a draft OF.
fn vault_for(draft: &NoteDraft, note_id: &str) -> rusqlite::Connection {
    let ddl = std::fs::read_to_string(root().join("contracts/schema/vault-ddl.sql"))
        .expect("the committed DDL is readable");
    let connection = open_contract_vault(&ddl, "[]").expect("the fixture vault is built");
    seed_owner_party(&connection, NOTES_DEMO_OWNER, "Priya", NOW).expect("the owner is seeded");
    centraid_apps_kit::fixtures::notes_editor_note(
        &connection,
        note_id,
        &draft.title,
        &draft.body,
        format_name(draft),
        NOW,
        NOTES_DEMO_OWNER,
    )
    .expect("the fixture note is seeded");
    connection
}

/// Every fixture decodes, and every one names its note — so a case added to the
/// directory without a `note_id` fails here rather than being skipped.
#[test]
fn every_notes_screen_fixture_decodes_and_names_its_note() {
    for case in ["loading", "draft-dirty", "read-refused", "save-refused"] {
        let state = fixture(case);
        assert!(!state.note_id.is_empty(), "{case} names no note");
        assert!(state.content.is_some(), "{case} has no content state");
        assert!(state.seat.is_some(), "{case} carries no seat state");
    }
}

/// `loading` OWES THE HANDLER NOTHING. The first load has no draft, so there is
/// nothing to lose and nothing to compare — which is why this case asserts the
/// ABSENCE rather than a value.
#[test]
fn the_loading_fixture_carries_no_draft_and_no_failure() {
    let state = fixture("loading");
    assert!(draft_of(&state).is_none());
    assert!(matches!(
        state.content,
        Some(notes_editor_state::Content::Loading(_))
    ));
    assert_eq!(state.save(), notes_editor_state::SaveState::Clean);
}

/// **THE ONE THAT MATTERS**: `load_note`'s fold produces the fixture's draft,
/// field for field.
#[test]
fn the_draft_fixture_is_exactly_what_the_note_query_answers() {
    let state = fixture("draft-dirty");
    let draft = draft_of(&state).expect("draft-dirty carries a draft");
    let connection = vault_for(draft, &state.note_id);
    let door = TestDoor::new(&connection);

    let (note, denial) = load_note(&door, &state.note_id).expect("the note reads");
    assert!(denial.is_none(), "the fixture's seat is READY");
    assert_eq!(note.note_id, state.note_id);
    assert_eq!(
        note.body, draft.body,
        "the editor's body IS the query's body — no re-wrapping, no trailing newline"
    );
    assert_eq!(note.format.as_deref(), Some(format_name(draft)));
    // AN EDIT NEVER WRITES: the fixture is DIRTY with no command submitted,
    // which is why the handler has no invocation to make here at all.
    assert_eq!(state.save(), notes_editor_state::SaveState::Dirty);
}

/// A REFUSED READ REPLACES THE EDITOR, because the body never arrived — and the
/// handler's answer is the denial, with an empty body.
#[test]
fn the_read_refused_fixture_is_what_a_denied_door_produces() {
    let state = fixture("read-refused");
    assert!(draft_of(&state).is_none(), "there is no draft to show");
    let failure = match state.content.as_ref() {
        Some(notes_editor_state::Content::Failure(failure)) => failure,
        _ => panic!("read-refused carries a ReadFailure"),
    };
    assert!(!failure.sentence.is_empty(), "a member is owed a sentence");

    let (note, denial) = load_note(&RefusingDoor, &state.note_id).expect("the read answers");
    let denial = denial.expect("a refused door is a denial, not an Err");
    assert!(denial.message.is_some());
    assert_eq!(note.note_id, state.note_id);
    assert_eq!(note.body, "", "the editor has nothing to draw");
    assert_eq!(note.format, None);
    // THE REVOCATION INSTANT IS THE HOST'S: an app whose grant was revoked
    // cannot read the consent tables to date its own revocation.
    assert_eq!(denial.revoked_at, None);
}

/// **A FAILED SAVE IS NOT A FAILED READ.** The fixture keeps the draft and puts
/// the sentence INSIDE it; the handler's read is unaffected, which is the whole
/// contrast the two refusal fixtures exist for.
#[test]
fn the_save_refused_fixture_keeps_the_body_the_query_answered() {
    let state = fixture("save-refused");
    let draft = draft_of(&state).expect("save-refused keeps its draft");
    assert!(
        draft.save_failure.is_some(),
        "the sentence rides the draft, not the content slot"
    );
    assert_eq!(state.save(), notes_editor_state::SaveState::Refused);

    let connection = vault_for(draft, &state.note_id);
    let door = TestDoor::new(&connection);
    let (note, denial) = load_note(&door, &state.note_id).expect("the note reads");
    assert!(
        denial.is_none(),
        "the READ succeeded; only the save was refused"
    );
    assert_eq!(note.body, draft.body);
    // …and the seat is OFFLINE with a queued write, which is what makes the
    // refusal a `queued`-adjacent state rather than a consent denial.
    let seat = state.seat.as_ref().expect("a seat state");
    assert_eq!(
        seat.pending.as_ref().map(|pending| pending.queued_writes),
        Some(1)
    );
}
