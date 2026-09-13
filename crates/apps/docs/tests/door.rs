//! THE FOUR QUERIES AGAINST A REAL VAULT, over rows the real commands wrote.
//!
//! The unit tests in `src/` prove the folds; this suite proves the STATEMENTS —
//! that every one of them parses under the kit's grammar, runs against the
//! committed schema, and answers what the fold expects. A fold that is right
//! over rows nobody could read is a fold that is wrong.
//!
//! Four claims here are not reachable any other way:
//!
//! 1. **The wrapper-identity property** (D-1020-DC1): a property test generates
//!    *n* wrappers over ONE content id and asserts *n* distinct drive rows.
//! 2. **`SHARE_FAN_OUT` is a REACHABLE bound** (D-1020-D3-12): 4,000 rows walk
//!    and the 4,001st errors with the cap it names — not with a short answer.
//! 3. **A denied read is a value.** A door that refuses the share plane leaves
//!    `shared_with` as `Denied` on every row while the drive still draws.
//! 4. **The staged-PDF round trip through the byte door** (D-1020-DC4): bytes
//!    in through `stage`, a URL out through `url`, and the never-inline rule
//!    applied to what the document reads them as.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use centraid_apps_docs::bytes::{
    ByteDoor, ByteRefusal, ByteRequest, ServedUrl, StagedBlob, door_unavailable,
};
use centraid_apps_docs::queries::{
    DriveInput, load_activity, load_drive, load_history, load_search,
};
use centraid_apps_docs::shares::{Audience, SHARE_FAN_OUT, Via};
use centraid_apps_docs::{Reading, commands};
use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::fixtures;
use centraid_apps_kit::page::PageRequest;
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_kit::row::{Cell, Row};
use centraid_apps_kit::statement::PageQuery;
use centraid_apps_kit::testdoor::TestDoor;
use centraid_media::format::sha256_hex;
use centraid_vault::access::Principal;
use centraid_vault::backup::store::{BlobStore, FsBlobStore};
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Vault};
use serde_json::{Value, json};

/// The instant the whole suite is stamped at. Far in the future for the reason
/// the parity generators record: a `purge_at` compared against a host clock
/// cannot be held still.
const EPOCH: &str = "2099-06-01T09:00:00.000Z";

struct Drive {
    dir: PathBuf,
    vault: Vault,
    registry: Registry,
    principal: Principal,
}

impl Drive {
    fn founded(seed: &str) -> Self {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let clock = Arc::new(FixedClock::at(
            centraid_vault::clock::parse_iso_ms(EPOCH).expect("the epoch parses"),
        ));
        let vault = Vault::create_with(
            dir.join("vault.db"),
            Box::new(Arc::clone(&clock)),
            Box::new(SeededIds::new(seed)),
        )
        .expect("a vault is created");
        vault.found("Test", "Priya").expect("it is founded");
        let registry = Registry::with_system_commands().expect("the registry builds");
        registry.install(&vault).expect("the record installs");
        Self {
            dir,
            vault,
            registry,
            principal: Principal::owner("phone"),
        }
    }

    fn run(&self, command: &str, input: Value) -> Value {
        let outcome = self
            .vault
            .execute(
                &self.registry,
                &self.principal,
                &Command::new(command, input),
            )
            .unwrap_or_else(|error| panic!("`{command}`: {error}"));
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "`{command}` refused: {:?} / {:?}",
            outcome.predicate,
            outcome.reason
        );
        outcome.output
    }

    /// Read through the app's own door, under the OWNER's view.
    fn read<T>(&self, body: impl FnOnce(&TestDoor<'_>) -> T) -> T {
        self.vault
            .read(|connection| Ok(body(&TestDoor::new(connection))))
            .expect("the read runs")
    }

    /// Seed rows no command in this build writes, through the KIT's statements.
    ///
    /// An app crate holds no SQL (`sql-confinement`), and the share plane has no
    /// command surface here — its writers are a later lane — so the statements
    /// live in `centraid_apps_kit::fixtures` beside the one insert the app plane
    /// already has.
    fn seed(&self, body: impl FnOnce(&rusqlite::Connection) -> KitResult<()>) {
        self.vault
            .commit(|tx| {
                tx.set_producer("test.seed");
                body(tx.connection()).map_err(|error| centraid_vault::VaultError::Invariant {
                    context: error.to_string(),
                })?;
                Ok(())
            })
            .expect("the seed lands");
    }
}

impl Drop for Drive {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn text_uri(body: &str) -> String {
    format!("data:text/plain;charset=utf-8,{body}")
}

// ---------------------------------------------------------------------------

/// THE FOUR QUERIES, end to end over a drive the real commands built.
#[test]
fn the_four_queries_answer_over_rows_the_commands_wrote() {
    let drive = Drive::founded("docs-door");
    let leases = drive.run("core.create_folder", json!({ "name": "Leases" }))["folder_id"]
        .as_str()
        .expect("a folder id")
        .to_owned();
    let nested = drive.run(
        "core.create_folder",
        json!({ "name": "2024", "parent_folder_id": leases }),
    )["folder_id"]
        .as_str()
        .expect("a folder id")
        .to_owned();

    let filed = drive.run(
        "core.add_document",
        json!({
            "title": "Lease", "data_uri": text_uri("rent%20is%20due"),
            "folder_id": nested,
        }),
    );
    let document_id = filed["document_id"].as_str().expect("an id").to_owned();
    drive.run("core.star_document", json!({ "document_id": document_id }));
    drive.run(
        "core.tag_item",
        json!({
            "subject_type": "core.document", "subject_id": document_id,
            "label": "Housing"
        }),
    );
    // A second document, at the drive's top level and trashed.
    let trashed = drive.run(
        "core.add_document",
        json!({ "title": "Old lease", "data_uri": text_uri("expired") }),
    )["document_id"]
        .as_str()
        .expect("an id")
        .to_owned();
    drive.run("core.trash_document", json!({ "document_id": trashed }));

    let (data, denial) =
        drive.read(|door| load_drive(door, DriveInput::default(), EPOCH).expect("the drive reads"));
    assert!(denial.is_none(), "nothing was denied: {denial:?}");
    assert_eq!(data.window, 200, "the declared default");
    assert!(!data.truncated, "two documents is not a full window");
    assert!(data.shared_from_known, "the origin plane was readable");
    assert!(data.root_folder_id.is_some());

    // THE FOLDER RAIL, with the nesting v0's own read cannot see.
    let names: Vec<&str> = data
        .folders
        .iter()
        .map(|folder| folder.name.as_deref().unwrap_or_default())
        .collect();
    assert_eq!(names, ["2024", "Leases"], "sorted by name, root excluded");
    let child = data
        .folders
        .iter()
        .find(|folder| folder.folder_id == nested)
        .expect("the nested folder");
    assert_eq!(
        child.parent_id.as_deref(),
        Some(leases.as_str()),
        "the nesting is visible because the projection carries broader_concept_id"
    );

    assert_eq!(data.documents.len(), 2);
    let row = data
        .documents
        .iter()
        .find(|row| row.document_id == document_id)
        .expect("the filed document");
    assert_eq!(row.title.as_deref(), Some("Lease"));
    assert_eq!(row.media_type.as_deref(), Some("text/plain"));
    assert_eq!(row.folder_id.as_deref(), Some(nested.as_str()));
    assert!(row.starred);
    assert!(!row.trashed);
    assert_eq!(
        row.tags
            .iter()
            .map(|tag| tag.label.as_str())
            .collect::<Vec<_>>(),
        ["Housing"],
        "the star and the folder tag are not labels"
    );
    // SHARED WITH NOBODY IS `Data(vec![])`, and it is not the same fact as a
    // denial.
    assert_eq!(row.shared_with, Reading::Data(Vec::new()));
    assert!(!row.shared_with.denied());
    assert!(row.shared_from.is_none(), "this one was not delivered here");
    // A `data:` URI passes through; there is no derivative to poster.
    assert!(
        row.content_uri
            .as_deref()
            .is_some_and(|uri| uri.starts_with("data:"))
    );
    assert_eq!(row.poster_uri, None);

    // THE TRASHED ONE IS IN THE WINDOW, with its purge date.
    let gone = data
        .documents
        .iter()
        .find(|row| row.document_id == trashed)
        .expect("trashed rows are in the drive");
    assert!(gone.trashed);
    assert!(gone.purge_at.is_some());

    // HISTORY: one version after an upload, two after an edit, and the newest
    // is current.
    let (history, denial) =
        drive.read(|door| load_history(door, &document_id).expect("the history reads"));
    assert!(denial.is_none());
    assert_eq!(history.versions.len(), 1);
    assert!(history.versions[0].current);
    assert_eq!(
        history.versions[0].media_type.as_deref(),
        Some("text/plain")
    );
    assert_eq!(
        history.versions[0].asserted_at.as_deref(),
        Some(EPOCH),
        "the occurrence's own instant"
    );

    drive.run(
        "core.edit_document",
        json!({ "document_id": document_id, "body_text": "rent moved" }),
    );
    let (history, _) =
        drive.read(|door| load_history(door, &document_id).expect("the history reads"));
    assert_eq!(history.versions.len(), 2, "newest first");
    assert!(history.versions[0].current);
    assert!(!history.versions[1].current);

    // A DOCUMENT THAT IS NOT THERE HAS NO HISTORY, and that is not an error.
    let (empty, denial) =
        drive.read(|door| load_history(door, "no-such-document").expect("it reads"));
    assert!(empty.versions.is_empty());
    assert!(denial.is_none());
    let (empty, _) = drive.read(|door| load_history(door, "").expect("it reads"));
    assert!(empty.versions.is_empty());

    // ACTIVITY: the vault's own audit trail, and the gate order wrote it.
    let (activity, denial) =
        drive.read(|door| load_activity(door, &document_id).expect("the activity reads"));
    assert!(denial.is_none());
    assert!(
        activity.events.is_empty(),
        "the commands receipt against agent.command, not against the document — \
         an empty rail is honest and the fixture says so: {:?}",
        activity.events
    );

    // SEARCH: the hits are the FTS door's; the fold decorates them and keeps
    // rank order.
    let hits = drive.read(|door| {
        door.page(
            &centraid_apps_docs::queries::documents_statement(&[
                document_id.clone(),
                trashed.clone(),
            ])
            .expect("a bounded statement"),
            &PageRequest::first(10),
        )
        .expect("the hit rows read")
        .rows
    });
    let (found, denial) = drive.read(|door| load_search(door, &hits, EPOCH).expect("it reads"));
    assert!(denial.is_none());
    assert_eq!(
        found.documents.len(),
        2,
        "both carry a folders-scheme tag, trashed included"
    );
    for row in &found.documents {
        assert_eq!(
            row.snippet.as_deref(),
            Some(""),
            "no snippet is \"\", not null"
        );
    }
    // A HIT WITH NO FOLDERS-SCHEME TAG IS NOT A DOCUMENT OF THIS DRIVE.
    let mut stray = Row::new();
    stray.insert("document_id".to_owned(), Cell::Text("d-stray".to_owned()));
    stray.insert(
        "current_content_id".to_owned(),
        Cell::Text("c-stray".to_owned()),
    );
    let (none, _) = drive.read(|door| load_search(door, &[stray], EPOCH).expect("it reads"));
    assert!(none.documents.is_empty());
    let (none, _) = drive.read(|door| load_search(door, &[], EPOCH).expect("it reads"));
    assert!(none.documents.is_empty());
}

/// THE SHARE FOLD, over real `share_*` rows, both ways in.
#[test]
fn a_share_over_a_folder_above_a_document_reaches_it() {
    let drive = Drive::founded("docs-shares");
    let leases = drive.run("core.create_folder", json!({ "name": "Leases" }))["folder_id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let nested = drive.run(
        "core.create_folder",
        json!({ "name": "2024", "parent_folder_id": leases }),
    )["folder_id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let document_id = drive.run(
        "core.add_document",
        json!({ "title": "Lease", "data_uri": text_uri("rent"), "folder_id": nested }),
    )["document_id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let ana = drive.run("core.add_party", json!({ "display_name": "Ana" }))["party_id"]
        .as_str()
        .expect("an id")
        .to_owned();

    // A STANDING ANSWER over the GRANDPARENT folder, plus a live binding and a
    // delivered pass. The statements are the KIT's, because an app crate holds
    // no SQL and the share plane has no command surface in this build.
    let grandparent = leases.clone();
    let party = ana.clone();
    drive.seed(move |connection| {
        let owner = fixtures::owner_party_id(connection)?.expect("a founded vault has an owner");
        fixtures::seed_share_authority(
            connection,
            &fixtures::ShareSeed {
                authority_id: "g1",
                principal_kind: "person",
                principal_id: &party,
                subject_type: "docs.folder",
                subject_id: &grandparent,
                verb: "edit",
                expires_at: None,
                granted_by: &owner,
                at: EPOCH,
            },
        )?;
        fixtures::seed_party_vault_binding(connection, "b1", &party, "vault-ana", EPOCH)?;
        fixtures::seed_share_fulfillment(
            connection,
            "g1",
            "vault-ana",
            "delivered",
            Some(EPOCH),
            EPOCH,
        )
    });

    let (data, denial) =
        drive.read(|door| load_drive(door, DriveInput::default(), EPOCH).expect("the drive reads"));
    assert!(denial.is_none());
    let row = data
        .documents
        .iter()
        .find(|row| row.document_id == document_id)
        .expect("the document");
    let entries = row
        .shared_with
        .data()
        .expect("the share plane was readable");
    assert_eq!(entries.len(), 1, "the grandparent's answer reaches it");
    let entry = &entries[0];
    assert_eq!(
        entry.via,
        Via::Folder,
        "never `document` for a folder share"
    );
    assert_eq!(entry.container_id, leases);
    assert_eq!(entry.audience, Audience::Person);
    assert_eq!(entry.label, "Ana");
    assert_eq!(entry.member_count, 1);
    assert_eq!(
        entry.pending_count, 0,
        "a delivered pass makes the member current"
    );
    assert_eq!(entry.members[0].capability.as_str(), "read+write");

    // AN EXPIRED ANSWER IS NOT A LIVE ONE, even though the read returned it.
    drive.seed(|connection| {
        fixtures::amend_share_authority(connection, "g1", Some("2099-05-01T00:00:00.000Z"), None)
    });
    let (data, _) =
        drive.read(|door| load_drive(door, DriveInput::default(), EPOCH).expect("the drive reads"));
    let row = data
        .documents
        .iter()
        .find(|row| row.document_id == document_id)
        .expect("the document");
    assert_eq!(
        row.shared_with,
        Reading::Data(Vec::new()),
        "an answer that ran out is not an audience"
    );

    // A REVOKED ANSWER NEVER REACHES THE FOLD AT ALL — the read filters it.
    drive.seed(|connection| fixtures::amend_share_authority(connection, "g1", None, Some(EPOCH)));
    let (data, _) =
        drive.read(|door| load_drive(door, DriveInput::default(), EPOCH).expect("the drive reads"));
    assert_eq!(
        data.documents
            .iter()
            .find(|row| row.document_id == document_id)
            .expect("the document")
            .shared_with,
        Reading::Data(Vec::new())
    );
}

/// D-1020-D3-12: THE BOUND REACHES THE SIZE IT NAMES, AND ERRORS THERE.
///
/// 4,000 standing answers walk; the 4,001st makes the walk error with the cap
/// it named. Not a short answer — a document quietly losing an audience is the
/// defect `SHARE_FAN_OUT` replaced.
#[test]
fn the_share_fan_out_reaches_four_thousand_and_errors_at_the_next_row() {
    let drive = Drive::founded("docs-fanout");
    let document_id = drive.run(
        "core.add_document",
        json!({ "title": "Popular", "data_uri": text_uri("many") }),
    )["document_id"]
        .as_str()
        .expect("an id")
        .to_owned();

    let seed = |drive: &Drive, range: std::ops::Range<usize>, document_id: &str| {
        let document_id = document_id.to_owned();
        drive.seed(move |connection| {
            let owner = fixtures::owner_party_id(connection)?.expect("an owner");
            fixtures::seed_standing_answers(
                connection,
                "core.document",
                &document_id,
                range,
                &owner,
                EPOCH,
            )
            .map(|_| ())
        });
    };

    let statement = centraid_apps_docs::shares::answers_statement(
        "core.document",
        std::slice::from_ref(&document_id),
    )
    .expect("a bounded statement");

    // Exactly the cap: it walks.
    seed(&drive, 0..SHARE_FAN_OUT.cap(), &document_id);
    let rows =
        drive.read(|door| centraid_apps_kit::reads::read_pages(door, &statement, SHARE_FAN_OUT));
    assert_eq!(
        rows.expect("the cap walks").len(),
        SHARE_FAN_OUT.cap(),
        "4,000 rows is the bound's own number and it reaches it"
    );

    // One more: it errors, and the error names the reachable cap.
    seed(
        &drive,
        SHARE_FAN_OUT.cap()..SHARE_FAN_OUT.cap() + 1,
        &document_id,
    );
    let refused =
        drive.read(|door| centraid_apps_kit::reads::read_pages(door, &statement, SHARE_FAN_OUT));
    match refused {
        Err(KitError::FanOutExceeded { query, cap }) => {
            assert_eq!(query, "docs.shares.answers.core.document");
            assert_eq!(cap, 4_000, "the cap it names is the cap it reached");
        }
        other => panic!("the bound must error at its own size, not answer short: {other:?}"),
    }

    // AND THE WHOLE QUERY SURFACES IT rather than drawing a document with
    // fewer audiences than it has: `load_drive` answers `Err`, which the
    // surface renders as a failure, never as an empty share list.
    let surfaced = drive.read(|door| load_drive(door, DriveInput::default(), EPOCH));
    assert!(
        matches!(surfaced, Err(KitError::FanOutExceeded { .. })),
        "a reached ceiling is not a denial and not a short answer"
    );
}

/// A DENIED READ IS A VALUE. The drive still draws; `shared_with` says it
/// cannot be seen.
#[test]
fn a_refused_share_plane_leaves_the_drive_drawable() {
    /// A door that answers every share statement with a refusal and passes
    /// everything else through — the shape of a newly declared scope parked for
    /// the owner to approve (#821).
    struct Parked<'a> {
        inner: TestDoor<'a>,
    }
    impl PageDoor for Parked<'_> {
        fn page(
            &self,
            query: &PageQuery,
            request: &PageRequest,
        ) -> centraid_apps_kit::error::KitResult<centraid_apps_kit::page::Page<Row>> {
            if query.name.starts_with("docs.shares.") {
                return Err(KitError::Door(
                    "ask the owner to approve sharing".to_owned(),
                ));
            }
            self.inner.page(query, request)
        }
    }

    let drive = Drive::founded("docs-parked");
    let document_id = drive.run(
        "core.add_document",
        json!({ "title": "Lease", "data_uri": text_uri("rent") }),
    )["document_id"]
        .as_str()
        .expect("an id")
        .to_owned();

    let (data, denial) = drive
        .vault
        .read(|connection| {
            let door = Parked {
                inner: TestDoor::new(connection),
            };
            Ok(load_drive(&door, DriveInput::default(), EPOCH).expect("the drive still reads"))
        })
        .expect("the read runs");
    assert!(
        denial.is_none(),
        "the DRIVE was not denied, the shares were"
    );
    let row = data
        .documents
        .iter()
        .find(|row| row.document_id == document_id)
        .expect("the document is still drawn");
    assert!(row.shared_with.denied(), "we cannot see");
    assert!(
        row.shared_with.data().is_none(),
        "and `data()` is not a default: a caller must decide what unknown prints as"
    );
    assert_eq!(
        row.title.as_deref(),
        Some("Lease"),
        "the row is otherwise whole"
    );
}

/// D-1020-DC4: THE STAGED-PDF ROUND TRIP, through the byte door.
#[test]
fn a_pdf_rides_in_through_stage_and_out_through_a_url() {
    /// The door over a real content-addressed store. This is what the seat's
    /// `centraid://` handler is; the app crate holds the trait and no bytes.
    struct StoreDoor {
        store: FsBlobStore,
    }
    impl ByteDoor for StoreDoor {
        fn read_text(&self, request: &ByteRequest) -> Reading<String> {
            let Some(content_id) = request.content_id() else {
                return Reading::Denied(door_unavailable("staged bytes have no id yet"));
            };
            match self.store.get(content_id) {
                Ok(bytes) => String::from_utf8(bytes).map_or_else(
                    |_| Reading::Denied(door_unavailable("those bytes are not text")),
                    Reading::Data,
                ),
                Err(error) => Reading::Denied(door_unavailable(&error.to_string())),
            }
        }
        fn url(&self, request: &ByteRequest) -> Reading<ServedUrl> {
            let ByteRequest::Url {
                content_id,
                media_type,
            } = request
            else {
                return Reading::Denied(door_unavailable("that is not a URL request"));
            };
            Reading::Data(ServedUrl::of(
                &format!("centraid://blob/{content_id}"),
                media_type.as_deref(),
            ))
        }
        fn stage(&self, request: &ByteRequest, bytes: &[u8]) -> Reading<StagedBlob> {
            let ByteRequest::Stage { media_type, .. } = request else {
                return Reading::Denied(door_unavailable("that is not a staging request"));
            };
            match self.store.put(bytes) {
                Ok(sha256) => Reading::Data(StagedBlob {
                    sha256,
                    byte_size: bytes.len(),
                    media_type: media_type.clone(),
                }),
                Err(error) => Reading::Denied(door_unavailable(&error.to_string())),
            }
        }
    }

    let drive = Drive::founded("docs-bytes");
    let store = FsBlobStore::open(drive.dir.join("blobs")).expect("a store opens");
    let door = StoreDoor { store };
    let pdf = b"%PDF-1.7\n% a scanned lease\ntrailer<</Root 1 0 R>>\n%%EOF\n".to_vec();

    // IN: `stageBlob`.
    let staged = door.stage(
        &ByteRequest::Stage {
            media_type: "application/pdf".to_owned(),
            byte_size: pdf.len(),
            original_name: Some("lease.pdf".to_owned()),
        },
        &pdf,
    );
    let staged = staged.data().expect("the bytes landed").clone();
    assert_eq!(staged.sha256, sha256_hex(&pdf), "the sha is the bytes' own");
    assert!(staged.sha_is_well_formed(), "a claim will accept this sha");
    assert_eq!(staged.byte_size, pdf.len());

    // THE CLAIM: the same sha, through the real command.
    let sha = staged.sha256.clone();
    let media_type = staged.media_type.clone();
    let byte_size = i64::try_from(staged.byte_size).expect("a size");
    let now = EPOCH.to_owned();
    let staging_id = drive.vault.ids().next();
    drive.seed(move |connection| {
        fixtures::seed_blob_staging(
            connection,
            &staging_id,
            &sha,
            &media_type,
            byte_size,
            Some("lease.pdf"),
            &now,
        )
    });
    let added = drive.run(
        "core.add_document",
        json!({ "title": "Scanned lease", "staged_sha": staged.sha256 }),
    );
    let content_id = added["content_id"].as_str().expect("an id").to_owned();

    // OUT: `blobUrl`, with the document's own reading of the bytes.
    let (data, _) = drive.read(|read_door| {
        load_drive(read_door, DriveInput::default(), EPOCH).expect("the drive reads")
    });
    let row = &data.documents[0];
    assert_eq!(row.media_type.as_deref(), Some("application/pdf"));
    let served = door
        .url(&ByteRequest::url(&content_id, row.media_type.as_deref()))
        .data()
        .expect("a URL")
        .clone();
    assert_eq!(served.url, format!("centraid://blob/{content_id}"));
    assert!(served.inline, "a PDF may be shown in a viewer");
    // AND A `blob:` CONTENT URI BECAME A SAME-ORIGIN ROUTE for range requests.
    assert_eq!(
        row.content_uri.as_deref(),
        Some(format!("/centraid/_vault/blobs/{content_id}").as_str())
    );

    // THE BYTES THEMSELVES COME BACK, verified against the digest the row names.
    let fetched = door.store.get(&staged.sha256).expect("the bytes are there");
    assert_eq!(fetched, pdf);

    // F's NEVER-INLINE RULE, applied to a document Docs would otherwise
    // quick-look: a shared `text/html` is attacker-authored bytes and is never
    // rendered inline (#865).
    let refused = ByteRequest::read_text(&content_id, "text/html", 10)
        .expect_err("html never rides a quick look");
    assert!(matches!(refused, ByteRefusal::NeverInline { .. }));
    assert!(!ServedUrl::of("centraid://blob/x", Some("image/svg+xml")).inline);
    // A TEXT BODY DOES ride one, and the round trip reads it back.
    let text = b"rent is due on the first".to_vec();
    let staged_text = door
        .stage(
            &ByteRequest::Stage {
                media_type: "text/plain".to_owned(),
                byte_size: text.len(),
                original_name: None,
            },
            &text,
        )
        .data()
        .expect("the text landed")
        .clone();
    let request = ByteRequest::read_text(&staged_text.sha256, "text/plain", text.len())
        .expect("a small text body");
    assert_eq!(
        door.read_text(&request).data().map(String::as_str),
        Some("rent is due on the first")
    );
}

/// Every action's invocation reaches a command the registry actually carries.
///
/// The two tables are written in two crates, and "the app names a command the
/// vault does not have" is a failure that only shows up at runtime otherwise.
#[test]
fn every_action_names_a_command_this_build_registers() {
    let registry = Registry::with_system_commands().expect("the registry builds");
    for row in commands::ACTIONS {
        assert!(
            registry.get(row.command).is_some(),
            "{} invokes {}, which is not registered",
            row.action,
            row.command
        );
    }
    let invocation = commands::invocation_for("upload", "docs:0", BTreeMap::new())
        .expect("upload is in the table");
    assert!(registry.get(invocation.command).is_some());
}

/// D-1020-DC1, AS A PROPERTY: *n* wrappers over ONE content id are *n* drive
/// rows.
///
/// Generated rather than typed, because the claim is about arity: a port that
/// keyed a drive row by content id would answer ONE row for any *n*, and a
/// hand-written case at *n* = 2 is the one number such a port might special-case.
mod wrapper_identity {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(12))]
        #[test]
        fn n_wrappers_over_one_sha_are_n_drive_rows(count in 1usize..7) {
            let drive = Drive::founded("docs-identity-property");
            let uri = text_uri("one%20set%20of%20bytes");
            let mut document_ids: Vec<String> = Vec::new();
            let mut content_ids: Vec<String> = Vec::new();
            for index in 0..count {
                let added = drive.run(
                    "core.add_document",
                    json!({ "title": format!("Copy {index}"), "data_uri": uri }),
                );
                prop_assert_eq!(
                    added["deduped"].as_i64(),
                    Some(i64::from(index > 0)),
                    "only the first filing mints the bytes"
                );
                document_ids.push(added["document_id"].as_str().unwrap_or_default().to_owned());
                content_ids.push(added["content_id"].as_str().unwrap_or_default().to_owned());
            }
            content_ids.dedup();
            prop_assert_eq!(content_ids.len(), 1, "one sha is one content item");

            let (data, denial) = drive.read(|door| {
                load_drive(door, DriveInput::default(), EPOCH).expect("the drive reads")
            });
            prop_assert!(denial.is_none());
            prop_assert_eq!(data.documents.len(), count, "n wrappers are n rows");
            let mut seen: Vec<&str> = data
                .documents
                .iter()
                .map(|row| row.document_id.as_str())
                .collect();
            seen.sort_unstable();
            let before = seen.len();
            seen.dedup();
            prop_assert_eq!(before, seen.len(), "and every row is a distinct document");
            // Each carries its OWN history, over the same bytes.
            for document_id in &document_ids {
                let (history, _) = drive.read(|door| {
                    load_history(door, document_id).expect("the history reads")
                });
                prop_assert_eq!(history.versions.len(), 1);
                prop_assert_eq!(
                    history.versions[0].content_id.as_str(),
                    content_ids[0].as_str()
                );
            }
        }
    }
}
