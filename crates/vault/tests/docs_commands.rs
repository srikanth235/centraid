//! THE SIXTEEN `core.*` COMMANDS DOCS WRITES THROUGH (#1020 slot 4b).
//!
//! `crates/vault/tests/tally_commands.rs` replays a generated script and
//! compares rows; this suite is the other half of the same proof — the
//! behaviours a script cannot show, each one a claim a port gets wrong:
//!
//! 1. **Identity is the wrapper** (D-1020-DC1). Two documents over one sha are
//!    two drive rows, two histories and two representations; only the BYTES are
//!    deduped, and `deduped: 1` is how the second filing says so.
//! 2. **A staged PDF is real** (D-1020-DC8). `promoteStagedBlob` is pure row
//!    work, so the whole `staged_sha` path lands here: staged, claimed,
//!    versioned, restored, and its bytes fetched back out of a real
//!    content-addressed store whose digest is the one the row names.
//! 3. **History never rewrites** (#996 R20(a), rule R3). A→B→A→B is four
//!    occurrences, a restore is a new FORWARD one, and a content id from
//!    another document's history is refused by name.
//! 4. **The trash keeps the folder and the star**, so a restore lands where it
//!    was; and `empty_document_trash` collapses a window rather than deleting
//!    anything.
//! 5. **A refusal is receipted, not thrown.** Every gate below is asserted
//!    through `Vault::execute`'s own answer, which is the shape a surface
//!    renders.

mod common;

use centraid_media::format::sha256_hex;
use centraid_vault::access::Principal;
use centraid_vault::backup::store::{BlobStore, FsBlobStore, digest};
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandOutcome, CommandStatus, Vault};
use serde_json::{Value, json};

/// A founded vault with the registry installed, and its owner's principal.
struct Drive {
    scratch: common::Scratch,
    registry: Registry,
    principal: Principal,
}

impl Drive {
    fn open(seed: &str) -> Self {
        let scratch = common::Scratch::founded(seed).expect("a vault is founded");
        let registry = Registry::with_system_commands().expect("the registry builds");
        registry
            .install(&scratch.vault)
            .expect("the registry's record installs");
        Self {
            scratch,
            registry,
            principal: Principal::owner("phone"),
        }
    }

    fn vault(&self) -> &Vault {
        &self.scratch.vault
    }

    /// Run a command, expecting it to execute.
    fn run(&self, command: &str, input: Value) -> Value {
        let outcome = self.try_run(command, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "`{command}` refused: {:?} / {:?}",
            outcome.predicate,
            outcome.reason
        );
        outcome.output
    }

    /// Run a command and hand back whatever it settled as — including a
    /// receipted refusal, which is a VALUE and not an `Err`.
    fn try_run(&self, command: &str, input: Value) -> CommandOutcome {
        self.vault()
            .execute(
                &self.registry,
                &self.principal,
                &Command::new(command, input),
            )
            .unwrap_or_else(|error| panic!("`{command}` errored rather than answering: {error}"))
    }

    fn count(&self, sql: &str, binds: &[&str]) -> i64 {
        self.vault()
            .read(|connection| {
                let params: Vec<&dyn rusqlite::ToSql> = binds
                    .iter()
                    .map(|bind| bind as &dyn rusqlite::ToSql)
                    .collect();
                Ok(connection.query_row(sql, params.as_slice(), |row| row.get(0))?)
            })
            .expect("the count reads")
    }

    fn text(&self, sql: &str, binds: &[&str]) -> Option<String> {
        self.vault()
            .read(|connection| {
                let params: Vec<&dyn rusqlite::ToSql> = binds
                    .iter()
                    .map(|bind| bind as &dyn rusqlite::ToSql)
                    .collect();
                Ok(connection
                    .query_row(sql, params.as_slice(), |row| {
                        row.get::<_, Option<String>>(0)
                    })
                    .ok()
                    .flatten())
            })
            .expect("the read runs")
    }

    /// Stage bytes the way `POST /_vault/blobs` does: the row the claim reads,
    /// and the bytes in a real content-addressed store beside it.
    fn stage(&self, store: &FsBlobStore, bytes: &[u8], media_type: &str, name: &str) -> String {
        let sha = digest(bytes);
        assert_eq!(sha, sha256_hex(bytes), "the store's digest is the sha");
        store.put(bytes).expect("the bytes land in the store");
        let staging_id = self.vault().ids().next();
        let now = self.vault().clock().now_text();
        let sha_for_row = sha.clone();
        let name = name.to_owned();
        let media_type = media_type.to_owned();
        let byte_size = i64::try_from(bytes.len()).expect("a size");
        self.vault()
            .commit(|tx| {
                tx.set_producer("test.stage");
                tx.connection().execute(
                    "INSERT INTO blob_staging
                       (staging_id, sha256, media_type, byte_size, original_name,
                        meta_json, staged_by, held_by_batch, variant, variant_of,
                        inline_content, staged_at, held_by_intent)
                     VALUES (?1, ?2, ?3, ?4, ?5, '{}', NULL, NULL, NULL, NULL, NULL, ?6, NULL)",
                    rusqlite::params![staging_id, sha_for_row, media_type, byte_size, name, now],
                )?;
                Ok(())
            })
            .expect("the staging row lands");
        sha
    }
}

fn text_uri(body: &str) -> Value {
    // The percent-escaping is the command's business; a plain ASCII body needs
    // none, which keeps this fixture readable.
    json!(format!("data:text/plain;charset=utf-8,{body}"))
}

/// A minimal but REAL PDF: the header bytes a sniffer reads and a trailer, so
/// the thing being staged is a document and not a string that says "pdf".
fn pdf_bytes(title: &str) -> Vec<u8> {
    format!("%PDF-1.7\n% {title}\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n")
        .into_bytes()
}

// ---------------------------------------------------------------------------

/// D-1020-DC1: TWO DOCUMENTS MAY SHARE BYTES, AND THEY ARE STILL TWO.
///
/// A port that keyed a drive row by content id merges two members' unrelated
/// files (census §A3). The wrapper is the identity, so the second filing gets
/// `deduped: 1`, its own `core_document` row, its own representation and its
/// own first occurrence over the SAME content item.
#[test]
fn two_documents_over_one_sha_are_two_documents() {
    let drive = Drive::open("docs-identity");
    let uri = text_uri("the same lease, twice");

    let first = drive.run(
        "core.add_document",
        json!({ "title": "Lease (mine)", "data_uri": uri }),
    );
    let second = drive.run(
        "core.add_document",
        json!({ "title": "Lease (theirs)", "data_uri": uri }),
    );

    assert_eq!(
        first["deduped"],
        json!(0),
        "the first filing mints the bytes"
    );
    assert_eq!(second["deduped"], json!(1), "the second dedupes the BYTES");
    assert_eq!(
        first["content_id"], second["content_id"],
        "one sha is one content item"
    );
    assert_ne!(
        first["document_id"], second["document_id"],
        "and two documents are two documents"
    );

    let content_id = first["content_id"].as_str().expect("a content id");
    assert_eq!(
        drive.count(
            "SELECT COUNT(*) FROM core_content_item WHERE content_id = ?1",
            &[content_id]
        ),
        1
    );
    // TWO REPRESENTATIONS over one sha: what the bytes ARE is a property of the
    // owner (#996 R20(b)), which is why the kit's index is owner-keyed.
    assert_eq!(
        drive.count(
            "SELECT COUNT(*) FROM core_content_representation WHERE content_id = ?1",
            &[content_id]
        ),
        2
    );
    // TWO HISTORIES. While a version was a content id, these two documents
    // shared one.
    for document in [&first, &second] {
        let document_id = document["document_id"].as_str().expect("a document id");
        assert_eq!(
            drive.count(
                "SELECT COUNT(*) FROM core_entity_revision
                  WHERE entity_type = 'core.document' AND entity_id = ?1",
                &[document_id]
            ),
            1,
            "each document's original body is its own first occurrence"
        );
    }
    // AND TWO DRIVE ROWS, each filed exactly once.
    assert_eq!(
        drive.count(
            "SELECT COUNT(*) FROM core_tag t
               JOIN core_concept c ON c.concept_id = t.concept_id
               JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
              WHERE t.target_type = 'core.document'
                AND s.uri = 'https://centraid.dev/schemes/folders'",
            &[]
        ),
        2
    );
}

/// THE WHOLE TEXT PATH, and every gate in front of it.
#[test]
fn a_text_document_files_edits_and_versions() {
    let drive = Drive::open("docs-text");
    let folder = drive.run("core.create_folder", json!({ "name": "Leases" }));
    let folder_id = folder["folder_id"]
        .as_str()
        .expect("a folder id")
        .to_owned();

    let added = drive.run(
        "core.add_document",
        json!({
            "title": "Lease", "data_uri": text_uri("rent is due on the first"),
            "folder_id": folder_id,
        }),
    );
    let document_id = added["document_id"].as_str().expect("an id").to_owned();

    // THE FTS FEED IS FED AT WRITE TIME (#996 R4/R8).
    assert_eq!(
        drive
            .text(
                "SELECT ct.body_text FROM core_document d
               JOIN core_content_text ct ON ct.content_id = d.current_content_id
              WHERE d.document_id = ?1",
                &[&document_id]
            )
            .as_deref(),
        Some("rent is due on the first")
    );

    // An edit mints a new occurrence and carries the media type forward.
    let edited = drive.run(
        "core.edit_document",
        json!({ "document_id": document_id, "body_text": "rent is due on the second" }),
    );
    assert_ne!(edited["content_id"], added["content_id"]);
    assert_eq!(
        drive
            .text(
                "SELECT media_type FROM core_content_representation
              WHERE owner_type = 'core.document' AND owner_id = ?1",
                &[&document_id]
            )
            .as_deref(),
        Some("text/plain"),
        "an edit changes the words, never the format"
    );

    // A NO-OP EDIT RECORDS NO VERSION: dedup lands back on the same content id,
    // so there is nothing to say a version revised.
    let same = drive.run(
        "core.edit_document",
        json!({ "document_id": document_id, "body_text": "rent is due on the second" }),
    );
    assert_eq!(same["content_id"], edited["content_id"]);
    assert_eq!(
        drive.count(
            "SELECT COUNT(*) FROM core_entity_revision
              WHERE entity_type = 'core.document' AND entity_id = ?1",
            &[&document_id]
        ),
        2,
        "two versions, not three"
    );

    // A title rides along as a partial update.
    drive.run(
        "core.edit_document",
        json!({
            "document_id": document_id, "body_text": "rent is due on the third",
            "title": "Lease (2024)"
        }),
    );
    assert_eq!(
        drive
            .text(
                "SELECT title FROM core_document WHERE document_id = ?1",
                &[&document_id]
            )
            .as_deref(),
        Some("Lease (2024)")
    );
}

/// D-1020-DC8: A STAGED PDF IS A REAL DOCUMENT, and an inline one is refused
/// with a sentence naming the seam.
#[test]
fn a_staged_pdf_files_and_an_inline_one_is_refused_by_name() {
    let drive = Drive::open("docs-staged");
    let store = FsBlobStore::open(drive.scratch.join("blobs")).expect("a store opens");
    let bytes = pdf_bytes("a scanned lease");
    let sha = drive.stage(&store, &bytes, "application/pdf", "lease.pdf");

    let added = drive.run(
        "core.add_document",
        json!({ "title": "Scanned lease", "staged_sha": sha }),
    );
    let document_id = added["document_id"].as_str().expect("an id").to_owned();
    let content_id = added["content_id"].as_str().expect("an id").to_owned();

    // THE ROW NAMES THE CAS, never the bytes.
    assert_eq!(
        drive
            .text(
                "SELECT content_uri FROM core_content_item WHERE content_id = ?1",
                &[&content_id]
            )
            .as_deref(),
        Some(format!("blob:sha256-{sha}").as_str())
    );
    // THE READING IS THIS DOCUMENT'S, from what the upload said.
    assert_eq!(
        drive
            .text(
                "SELECT media_type FROM core_content_representation
                  WHERE owner_type = 'core.document' AND owner_id = ?1",
                &[&document_id]
            )
            .as_deref(),
        Some("application/pdf")
    );
    // A PDF IS NOT TEXT, so no `core_content_text` row exists for it — absence
    // is the answer "these bytes did not decode", never an empty body.
    assert_eq!(
        drive.count(
            "SELECT COUNT(*) FROM core_content_text WHERE content_id = ?1",
            &[&content_id]
        ),
        0
    );
    // THE STAGING ROW IS CONSUMED.
    assert_eq!(
        drive.count(
            "SELECT COUNT(*) FROM blob_staging WHERE sha256 = ?1",
            &[&sha]
        ),
        0
    );
    // AND THE BYTES COME BACK OUT OF THE STORE, verified against the digest the
    // row names — the round trip, end to end.
    let fetched = store.get(&sha).expect("the bytes are there");
    assert_eq!(fetched, bytes);
    assert_eq!(sha256_hex(&fetched), sha);

    // BYTES THIS VAULT DOES NOT ALREADY HOLD, pasted INLINE, refuse — and the
    // sentence says what to do instead.
    //
    // The bytes have to be NEW, and that is a behaviour rather than a fixture
    // detail: the mint dedupes BEFORE it would spill, so re-presenting bytes
    // the CAS already holds succeeds for any media type — no spill is needed to
    // point a second wrapper at a content item that exists. v0's mint has the
    // same order (`blob/mint.ts:69`-`:88`), so this is parity and not a gap.
    let unseen = pdf_bytes("a lease nothing staged");
    assert_ne!(sha256_hex(&unseen), sha);
    let inline = format!("data:application/pdf;base64,{}", base64_of(&unseen));
    let refused = drive.try_run(
        "core.add_document",
        json!({ "title": "Pasted lease", "data_uri": inline }),
    );
    assert_eq!(refused.status, CommandStatus::Failed);
    // A GATE, NOT A THROW: the refusal is receipted with its own predicate.
    assert_eq!(
        refused.predicate.as_deref(),
        Some("inline_bytes_are_storable")
    );
    let reason = refused.reason.unwrap_or_default();
    assert!(
        reason.contains("staged_sha") && reason.contains("application/pdf"),
        "the refusal has to name both the type and the way through: {reason}"
    );
    // AND NOTHING WAS LEFT BEHIND: a refused call mints no wrapper.
    assert_eq!(
        drive.count("SELECT COUNT(*) FROM core_document", &[]),
        1,
        "the refused filing left no document"
    );
}

/// A staged PDF's extracted text feeds the parent's index — the seam the
/// automations lane writes through, proven from both doors.
#[test]
fn extracted_text_lands_from_the_claim_and_from_the_command() {
    let drive = Drive::open("docs-ocr");
    let store = FsBlobStore::open(drive.scratch.join("blobs")).expect("a store opens");
    let sha = drive.stage(&store, &pdf_bytes("receipts"), "application/pdf", "r.pdf");

    let added = drive.run(
        "core.add_document",
        json!({
            "title": "Receipt", "staged_sha": sha,
            "extracted_text": "TOTAL 42.00 GBP"
        }),
    );
    let content_id = added["content_id"].as_str().expect("an id").to_owned();
    assert_eq!(
        drive
            .text(
                "SELECT text_content FROM core_content_derivative
                  WHERE content_id = ?1 AND variant = 'text'",
                &[&content_id]
            )
            .as_deref(),
        Some("TOTAL 42.00 GBP")
    );

    // `core.set_extracted_text` REPLACES rather than adding, which is what
    // makes it retry-safe: the derivative's key is (content_id, variant).
    let replaced = drive.run(
        "core.set_extracted_text",
        json!({
            "content_id": content_id, "text": "TOTAL 42.00 GBP — paid",
            "capability": "ocr", "model": "bundled", "confidence": 0.91
        }),
    );
    assert_eq!(replaced["replaced"], json!(1));
    assert_eq!(
        drive.count(
            "SELECT COUNT(*) FROM core_content_derivative
              WHERE content_id = ?1 AND variant = 'text'",
            &[&content_id]
        ),
        1
    );
    // A second identical run is safe and still one row.
    let again = drive.run(
        "core.set_extracted_text",
        json!({ "content_id": content_id, "text": "TOTAL 42.00 GBP — paid" }),
    );
    assert_eq!(again["replaced"], json!(1));
    assert_eq!(
        drive.count(
            "SELECT COUNT(*) FROM core_content_derivative WHERE content_id = ?1",
            &[&content_id]
        ),
        1
    );
    // A transcript is a DIFFERENT variant and sits beside the text.
    drive.run(
        "core.set_extracted_text",
        json!({ "content_id": content_id, "text": "spoken words", "variant": "transcript" }),
    );
    assert_eq!(
        drive.count(
            "SELECT COUNT(*) FROM core_content_derivative WHERE content_id = ?1",
            &[&content_id]
        ),
        2
    );
    // Bytes nothing holds refuse.
    let refused = drive.try_run(
        "core.set_extracted_text",
        json!({ "content_id": "no-such-content", "text": "x" }),
    );
    assert_eq!(refused.status, CommandStatus::Failed);
    assert_eq!(refused.predicate.as_deref(), Some("content_item_live"));
}

/// #996 R20(a) AND RULE R3: A→B→A→B is four occurrences, a restore is a new
/// forward one, and another document's version is refused by name.
#[test]
fn history_never_rewrites_and_a_version_belongs_to_one_document() {
    let drive = Drive::open("docs-history");
    let a = drive.run(
        "core.add_document",
        json!({ "title": "Notes", "data_uri": text_uri("A") }),
    );
    let document_id = a["document_id"].as_str().expect("an id").to_owned();
    let content_a = a["content_id"].as_str().expect("an id").to_owned();

    let b = drive.run(
        "core.edit_document",
        json!({ "document_id": document_id, "body_text": "B" }),
    );
    let content_b = b["content_id"].as_str().expect("an id").to_owned();
    assert_ne!(content_a, content_b);

    // BACK TO A: the bytes already exist, so this is a restore and NOT a new
    // content item — and it is still a new occurrence.
    let back = drive.run(
        "core.restore_document_version",
        json!({ "document_id": document_id, "content_id": content_a }),
    );
    assert_eq!(back["content_id"], json!(content_a));
    // AND FORWARD TO B AGAIN.
    drive.run(
        "core.restore_document_version",
        json!({ "document_id": document_id, "content_id": content_b }),
    );
    assert_eq!(
        drive.count(
            "SELECT COUNT(*) FROM core_entity_revision
              WHERE entity_type = 'core.document' AND entity_id = ?1",
            &[&document_id]
        ),
        4,
        "A→B→A→B is four occurrences; a content-keyed walk had to collapse it to two"
    );
    // Every occurrence but the first names a parent, so the chain is walkable
    // and nothing before the restore was touched.
    assert_eq!(
        drive.count(
            "SELECT COUNT(*) FROM core_entity_revision
              WHERE entity_type = 'core.document' AND entity_id = ?1
                AND parent_revision_id IS NULL",
            &[&document_id]
        ),
        1
    );

    // ALREADY CURRENT refuses: a restore to the head is not a version gesture.
    let refused = drive.try_run(
        "core.restore_document_version",
        json!({ "document_id": document_id, "content_id": content_b }),
    );
    assert_eq!(refused.predicate.as_deref(), Some("not_already_current"));

    // ANOTHER DOCUMENT'S VERSION IS NOT THIS ONE'S HISTORY. The second document
    // shares no bytes with the first, and the refusal is by name.
    let other = drive.run(
        "core.add_document",
        json!({ "title": "Elsewhere", "data_uri": text_uri("Z") }),
    );
    let foreign = other["content_id"].as_str().expect("an id").to_owned();
    let refused = drive.try_run(
        "core.restore_document_version",
        json!({ "document_id": document_id, "content_id": foreign }),
    );
    assert_eq!(refused.predicate.as_deref(), Some("target_in_chain"));
    assert!(
        refused
            .reason
            .unwrap_or_default()
            .contains("a version belongs to one document")
    );
}

/// THE TRASH KEEPS THE FOLDER AND THE STAR, so a restore lands where it was —
/// and `empty_document_trash` collapses a window rather than destroying a row.
#[test]
fn the_trash_keeps_its_filing_and_emptying_it_collapses_a_window() {
    let drive = Drive::open("docs-trash");
    let folder = drive.run("core.create_folder", json!({ "name": "Taxes" }));
    let folder_id = folder["folder_id"].as_str().expect("an id").to_owned();
    let added = drive.run(
        "core.add_document",
        json!({ "title": "P60", "data_uri": text_uri("tax year"), "folder_id": folder_id }),
    );
    let document_id = added["document_id"].as_str().expect("an id").to_owned();
    drive.run("core.star_document", json!({ "document_id": document_id }));

    let trashed = drive.run("core.trash_document", json!({ "document_id": document_id }));
    let purge_at = trashed["purge_at"]
        .as_str()
        .expect("a purge date")
        .to_owned();
    assert!(purge_at > drive.vault().clock().now_text());

    // THE FOLDER TAG AND THE STAR SURVIVE.
    assert_eq!(
        drive.count(
            "SELECT COUNT(*) FROM core_tag WHERE target_type = 'core.document' AND target_id = ?1",
            &[&document_id]
        ),
        2,
        "the folder tag and the star"
    );
    // AND THE BYTES ARE UNTOUCHED (the retention stance, #352).
    assert_eq!(
        drive.count(
            "SELECT COUNT(*) FROM core_content_item WHERE deleted_at IS NOT NULL",
            &[]
        ),
        0
    );

    // A DOUBLE TRASH FAILS LOUDLY rather than re-stamping the date.
    let refused = drive.try_run("core.trash_document", json!({ "document_id": document_id }));
    assert_eq!(refused.predicate.as_deref(), Some("document_exists"));
    // A TRASHED DOCUMENT IS FROZEN.
    for command in [
        "core.rename_document",
        "core.star_document",
        "core.unstar_document",
    ] {
        let input = if command == "core.rename_document" {
            json!({ "document_id": document_id, "title": "no" })
        } else {
            json!({ "document_id": document_id })
        };
        let refused = drive.try_run(command, input);
        assert_eq!(
            refused.predicate.as_deref(),
            Some("document_exists"),
            "{command} should refuse a trashed document"
        );
    }
    // A FOLDER THAT STILL HOLDS A TRASHED DOCUMENT DOES NOT DELETE.
    let refused = drive.try_run("core.delete_folder", json!({ "folder_id": folder_id }));
    assert_eq!(refused.predicate.as_deref(), Some("folder_is_empty"));

    // RESTORE PUTS IT BACK WHERE IT WAS.
    drive.run(
        "core.restore_document",
        json!({ "document_id": document_id }),
    );
    let filed = drive
        .text(
            "SELECT t.concept_id FROM core_tag t
               JOIN core_concept c ON c.concept_id = t.concept_id
               JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
              WHERE t.target_id = ?1 AND s.uri = 'https://centraid.dev/schemes/folders'",
            &[&document_id],
        )
        .expect("still filed");
    assert_eq!(filed, folder_id);

    // EMPTYING THE TRASH IS A DATE. Trash it again, empty, and the window is
    // collapsed onto the row's own `deleted_at` — a moment provably past.
    drive.run("core.trash_document", json!({ "document_id": document_id }));
    let emptied = drive.run("core.empty_document_trash", json!({}));
    assert_eq!(emptied["documents_released"], json!(1));
    assert_eq!(
        drive.count(
            "SELECT COUNT(*) FROM core_document
              WHERE document_id = ?1 AND purge_at = deleted_at",
            &[&document_id]
        ),
        1
    );
    // NOTHING WAS DELETED HERE — the sweep is the only thing that destroys a
    // document, and it has not run.
    assert_eq!(drive.count("SELECT COUNT(*) FROM core_document", &[]), 1);
    // A RESTORE PAST THE WINDOW REFUSES (#916 review 1.5), compared against the
    // invocation's own instant.
    let refused = drive.try_run(
        "core.restore_document",
        json!({ "document_id": document_id }),
    );
    assert_eq!(refused.predicate.as_deref(), Some("document_in_trash"));
    // AN EMPTY TRASH IS A NO-OP THAT STILL EXECUTES, never a refusal.
    let again = drive.run("core.empty_document_trash", json!({}));
    assert_eq!(again["documents_released"], json!(1), "the same row, again");
}

/// FILING IS ONE TAG. A move REPLACES, and the folder plane's own rules —
/// distinct sibling names, no renaming the drive, no deleting a full folder —
/// are refusals with sentences.
#[test]
fn filing_is_one_tag_and_the_folder_plane_refuses_with_sentences() {
    let drive = Drive::open("docs-folders");
    let taxes = drive.run("core.create_folder", json!({ "name": "Taxes" }));
    let taxes_id = taxes["folder_id"].as_str().expect("an id").to_owned();
    let leases = drive.run("core.create_folder", json!({ "name": "Leases" }));
    let leases_id = leases["folder_id"].as_str().expect("an id").to_owned();

    // A SIBLING NAME IS TAKEN.
    let refused = drive.try_run("core.create_folder", json!({ "name": "Taxes" }));
    assert_eq!(
        refused.predicate.as_deref(),
        Some("name_unused_among_siblings")
    );
    // BUT NOT UNDER A DIFFERENT PARENT.
    let nested = drive.run(
        "core.create_folder",
        json!({ "name": "Taxes", "parent_folder_id": leases_id }),
    );
    assert!(nested["folder_id"].is_string());

    let added = drive.run(
        "core.add_document",
        json!({ "title": "P45", "data_uri": text_uri("left the job"), "folder_id": taxes_id }),
    );
    let document_id = added["document_id"].as_str().expect("an id").to_owned();

    // A MOVE REPLACES the one folders-scheme tag; the postcondition is what
    // would catch a duplicate filing.
    drive.run(
        "core.move_document",
        json!({ "document_id": document_id, "folder_id": leases_id }),
    );
    assert_eq!(
        drive
            .text(
                "SELECT t.concept_id FROM core_tag t
                   JOIN core_concept c ON c.concept_id = t.concept_id
                   JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                  WHERE t.target_id = ?1 AND s.uri = 'https://centraid.dev/schemes/folders'",
                &[&document_id]
            )
            .as_deref(),
        Some(leases_id.as_str())
    );

    // AN OMITTED FOLDER IS THE DRIVE'S TOP LEVEL, not a refusal.
    drive.run("core.move_document", json!({ "document_id": document_id }));
    assert_eq!(
        drive
            .text(
                "SELECT c.notation FROM core_tag t
                   JOIN core_concept c ON c.concept_id = t.concept_id
                   JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                  WHERE t.target_id = ?1 AND s.uri = 'https://centraid.dev/schemes/folders'",
                &[&document_id]
            )
            .as_deref(),
        Some("root")
    );

    // A FOLDER THAT IS NOT THERE REFUSES.
    let refused = drive.try_run(
        "core.move_document",
        json!({ "document_id": document_id, "folder_id": "no-such-folder" }),
    );
    assert_eq!(refused.predicate.as_deref(), Some("folder_exists_if_given"));

    // THE DRIVE'S OWN TOP LEVEL IS NOT A FOLDER: it neither renames nor deletes.
    let root_id = drive
        .text(
            "SELECT c.concept_id FROM core_concept c
               JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
              WHERE s.uri = 'https://centraid.dev/schemes/folders' AND c.notation = 'root'",
            &[],
        )
        .expect("the root exists once a document was filed");
    for (command, input) in [
        (
            "core.rename_folder",
            json!({ "folder_id": root_id, "name": "Everything" }),
        ),
        ("core.delete_folder", json!({ "folder_id": root_id })),
    ] {
        let refused = drive.try_run(command, input);
        assert_eq!(
            refused.predicate.as_deref(),
            Some("folder_exists_and_not_root"),
            "{command} should refuse the drive's top level"
        );
    }

    // A FOLDER WITH A SUBFOLDER IS NOT EMPTY.
    let refused = drive.try_run("core.delete_folder", json!({ "folder_id": leases_id }));
    assert_eq!(refused.predicate.as_deref(), Some("folder_is_empty"));
    // AN EMPTY ONE DELETES.
    drive.run(
        "core.rename_folder",
        json!({ "folder_id": taxes_id, "name": "Tax" }),
    );
    drive.run("core.delete_folder", json!({ "folder_id": taxes_id }));
    assert_eq!(
        drive.count(
            "SELECT COUNT(*) FROM core_concept WHERE concept_id = ?1",
            &[&taxes_id]
        ),
        0
    );
}

/// THE STAR IS ONE TAG ON THE WRAPPER, and a free-form label is another —
/// removing one by `tag_id` must not take the other with it.
#[test]
fn the_star_and_a_label_are_two_edges_and_untag_removes_one() {
    let drive = Drive::open("docs-tags");
    let added = drive.run(
        "core.add_document",
        json!({ "title": "Warranty", "data_uri": text_uri("two years") }),
    );
    let document_id = added["document_id"].as_str().expect("an id").to_owned();

    drive.run("core.star_document", json!({ "document_id": document_id }));
    // IDEMPOTENT: starring twice is one star.
    drive.run("core.star_document", json!({ "document_id": document_id }));
    let tagged = drive.run(
        "core.tag_item",
        json!({
            "subject_type": "core.document", "subject_id": document_id,
            "label": "Appliances"
        }),
    );
    let tag_id = tagged["tag_id"].as_str().expect("a tag id").to_owned();
    // Tagging the same label twice dedupes onto the one edge.
    let again = drive.run(
        "core.tag_item",
        json!({
            "subject_type": "core.document", "subject_id": document_id,
            "label": "appliances"
        }),
    );
    assert_eq!(again["tag_id"], json!(tag_id));

    assert_eq!(
        drive.count(
            "SELECT COUNT(*) FROM core_tag WHERE target_id = ?1",
            &[&document_id]
        ),
        3,
        "the folder tag, the star and one label"
    );

    // UNTAG REMOVES THE SPECIFIC EDGE.
    drive.run("core.untag_item", json!({ "tag_id": tag_id }));
    assert_eq!(
        drive.count(
            "SELECT COUNT(*) FROM core_tag WHERE target_id = ?1",
            &[&document_id]
        ),
        2,
        "the star and the folder tag are still there"
    );
    let refused = drive.try_run("core.untag_item", json!({ "tag_id": tag_id }));
    assert_eq!(refused.predicate.as_deref(), Some("tag_exists"));

    // UNSTAR takes the star and nothing else.
    drive.run(
        "core.unstar_document",
        json!({ "document_id": document_id }),
    );
    assert_eq!(
        drive.count(
            "SELECT COUNT(*) FROM core_tag WHERE target_id = ?1",
            &[&document_id]
        ),
        1
    );
}

/// THE BYTE-SOURCE GATES, each one refusing with its own predicate.
#[test]
fn the_byte_source_gates_each_refuse_by_name() {
    let drive = Drive::open("docs-gates");
    let store = FsBlobStore::open(drive.scratch.join("blobs")).expect("a store opens");

    // NEITHER SOURCE, and BOTH, are the same refusal: send the bytes one way.
    for input in [
        json!({ "title": "Nothing" }),
        json!({
            "title": "Both", "data_uri": text_uri("x"),
            "staged_sha": "ab".repeat(32)
        }),
    ] {
        let refused = drive.try_run("core.add_document", input);
        assert_eq!(refused.predicate.as_deref(), Some("exactly_one_source"));
    }

    // NOT A DATA URI.
    let refused = drive.try_run(
        "core.add_document",
        json!({ "title": "Wrong", "data_uri": "https://example.test/lease.pdf" }),
    );
    assert_eq!(refused.predicate.as_deref(), Some("is_data_uri"));

    // OVER THE INLINE DOOR: the journal records every input, so this is a
    // character count on the URI itself.
    let huge = format!("data:text/plain;charset=utf-8,{}", "a".repeat(360_001));
    let refused = drive.try_run(
        "core.add_document",
        json!({ "title": "Huge", "data_uri": huge }),
    );
    assert_eq!(refused.predicate.as_deref(), Some("within_size_cap"));

    // OVER THE TEXT BUDGET but under the door: a tighter second gate, and the
    // one that catches a body a text column cannot redirect.
    let long = format!("data:text/plain;charset=utf-8,{}", "b".repeat(65 * 1024));
    let refused = drive.try_run(
        "core.add_document",
        json!({ "title": "Long", "data_uri": long }),
    );
    assert_eq!(
        refused.predicate.as_deref(),
        Some("text_body_within_budget")
    );
    assert!(
        refused
            .reason
            .unwrap_or_default()
            .contains("the search index reads them in-transaction")
    );

    // BYTES NOTHING STAGED.
    let refused = drive.try_run(
        "core.add_document",
        json!({ "title": "Absent", "staged_sha": "cd".repeat(32) }),
    );
    assert_eq!(refused.predicate.as_deref(), Some("staged_or_owned"));

    // A SEAT-MINTED ID THE VAULT HOLDS IS A COLLISION, not an overwrite.
    let minted = "01920000-0000-7000-8000-000000000001";
    drive.run(
        "core.add_document",
        json!({ "document_id": minted, "title": "Mine", "data_uri": text_uri("mine") }),
    );
    let refused = drive.try_run(
        "core.add_document",
        json!({ "document_id": minted, "title": "Theirs", "data_uri": text_uri("theirs") }),
    );
    assert_eq!(refused.predicate.as_deref(), Some("document_id_is_free"));

    // AN IMAGE IS NOT TEXT: editing its body in place is refused, and the
    // sentence points at replace.
    let sha = drive.stage(&store, &pdf_bytes("scan"), "application/pdf", "s.pdf");
    let scan = drive.run(
        "core.add_document",
        json!({ "title": "Scan", "staged_sha": sha }),
    );
    let scan_id = scan["document_id"].as_str().expect("an id").to_owned();
    let refused = drive.try_run(
        "core.edit_document",
        json!({ "document_id": scan_id, "body_text": "not this way" }),
    );
    assert_eq!(
        refused.predicate.as_deref(),
        Some("current_content_is_text")
    );
    assert!(refused.reason.unwrap_or_default().contains("replace"));

    // REPLACE TAKES IT, with a new reading of new bytes.
    let second = drive.stage(&store, &pdf_bytes("rescan"), "application/pdf", "s2.pdf");
    let replaced = drive.run(
        "core.replace_document_content",
        json!({ "document_id": scan_id, "staged_sha": second, "title": "Scan (v2)" }),
    );
    assert_ne!(replaced["content_id"], scan["content_id"]);
    assert_eq!(
        drive.count(
            "SELECT COUNT(*) FROM core_entity_revision
              WHERE entity_type = 'core.document' AND entity_id = ?1",
            &[&scan_id]
        ),
        2
    );
}

/// `Buffer.from(bytes).toString("base64")`, for the inline refusal's fixture.
fn base64_of(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
