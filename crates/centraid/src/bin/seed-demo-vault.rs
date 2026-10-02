//! THE DEMO SCENARIO, PORTED (#1020, wave A; v0 `#290` and `#708`).
//!
//! ```text
//! cargo run -p centraid --bin seed-demo-vault -- <dir> [options]
//!
//!   --file <name>   the file to write inside <dir>  (default demo-vault.sqlite3)
//!   --name <text>   the vault's display name        (default "Demo vault")
//!   --only <a,b,c>  seed only these apps            (default: all eight)
//!   --force         overwrite a file that is ALREADY a vault
//! ```
//!
//! **WHY A SECOND VAULT IS SEEDABLE AT ALL.** The switcher is only testable
//! against two, and two vaults holding the same rows under the same name would
//! prove nothing: a switch that quietly did not happen would look exactly like
//! one that did. `--only` is what makes the difference VISIBLE on the
//! springboard — a vault seeded `--only docs,tasks,agenda` draws People, Notes,
//! Photos and Tally as genuinely empty, which is a state the grid already knows
//! how to say and does not have to invent.
//!
//! **One scenario across eight apps** — agenda, docs, locker, notes, people,
//! photos, tally and tasks: one weekend at Tahoe with Maya, Jake, Grandpa Ray and
//! Chris, with notes, a packing list and an uneven expense ledger. A demo
//! corpus is for reading like somebody's life rather than like
//! `Item 1, Item 2`.
//!
//! **SEVEN OF THE EIGHT ARE THE LIBRARY'S.** The scenario lives in
//! `centraid_core::sample`, which is also what a phone seeds its SAMPLE VAULT
//! from, so a fixture and a member's sample are one set of rows. This binary is
//! the thin caller: the command line, the guard below, the byte store, the
//! count it prints — and Locker, which is the one app that stays here because
//! it is sealed under the public demo words and must never reach a product
//! vault.
//!
//! **Locker's secrets are sealed under the demo words' `K`** (D-6). A Locker
//! whose items carry no secret leaves reveal, copy and Review with nothing to
//! walk, so this core is opened with [`DEMO_WORDS`] at index 0 — the public
//! BIP39 all-`abandon` vector, printed as `CENTRAID_DEMO_WORDS` — and each
//! item goes through the shell's own door: a Locker unlock, then
//! `locker.add_item` through `Handle::call`, which seals the typed secret
//! under `K` before the command plane sees it. A phone opened with those same
//! words reveals them; any other words answer `DID_NOT_OPEN`. The secrets are
//! test values (a published test card number, made-up passwords), never
//! anybody's.
//!
//! **THROUGH THE REAL COMMAND PLANE, never SQL.** `sql-confinement` refuses SQL
//! outside `crates/{ontology,vault,seat,search}` and `crates/apps/kit`, and the
//! refusal is what makes this fixture worth anything: rows written by
//! `Vault::execute` carry the `core_entity` siblings, the `row_version` and the
//! ledger entries a real write produces, so a tile reading them reads the shape
//! the product actually stores.
//!
//! **It is a DEV binary and it is not the product.** v0 kept the same
//! separation — its seeds sat behind a gateway route the shipped app called
//! only from a "fill with sample data" offer on the first-run screen. The vault
//! it writes is a throwaway.
//!
//! **AND `--file` IS THE INVITATION TO BREAK THAT, SO THE GUARD IS HERE.** This
//! run deletes `<dir>/<file>` and its `-wal`, `-shm` and `.bytes` siblings
//! before it founds, because a demo seeded on top of a previous run has counts
//! nobody can predict. Pointed at a gateway's own vault directory — which is
//! one `--file vault.db` away — that deletes the vault a gateway is serving and
//! founds a new one under a NEW `vault_id` in a directory still named after the
//! old one. It reported `CENTRAID_SEEDED` and looked like a success: a seat
//! bootstrapped off it, drew the founding state, and `MAX(seq)` in the log had
//! gone 1101 → 146. Two scenario runs were spent looking for a sync bug that
//! was not there.
//!
//! So a file that already holds a `core_vault` row is REFUSED by name, and
//! `--force` is the only way past. "It is a dev binary" is the argument for the
//! guard and not against it: a dev binary that can silently destroy a gateway's
//! vault is the one class worth guarding, and the cost is one read.
//!
//! **THE BYTES ARE REAL.** `media.add_asset` stages the library's compiled-in
//! frames through the content plane, and both shells draw the mosaic and the
//! grid from the files this seed leaves in `<stem>.bytes`. The one video seeds
//! its own bytes and no `poster` derivative — nothing in the workspace writes
//! that variant — so its cell draws empty while every photograph draws its
//! thumbnail.

use std::path::PathBuf;

use centraid_api_proto::core_v1 as wire;
use centraid_vault::commands::Registry;
use centraid_vault::{Principal, Vault};
use serde_json::{Value, json};

/// Which apps this run seeds.
///
/// `--only` NAMES WHAT TO KEEP rather than what to drop, because a list of
/// exclusions gets silently wrong every time an app is added: a new app would
/// join every vault that had never heard of it. A list of inclusions leaves a
/// new app out until somebody asks for it, which is the safer direction for a
/// fixture.
struct Wanted(Option<std::collections::BTreeSet<String>>);

impl Wanted {
    fn has(&self, app: &str) -> bool {
        self.0.as_ref().is_none_or(|only| only.contains(app))
    }
}

/// The scenario's options, off the command line.
struct Options {
    dir: PathBuf,
    file: String,
    name: String,
    wanted: Wanted,
    /// Overwrite a file that is already a vault. Off by default; see the
    /// module header for what it is protecting.
    force: bool,
}

fn options() -> Options {
    let mut args = std::env::args().skip(1);
    let mut dir = None;
    // A FLAT STAGING NAME. A shell adopts `<vault dir>/<name>/vault.db`, one
    // directory per vault (`Shelf.VAULT_FILE`, #1047 Q-1047-17), and
    // `mobile/scripts/demo-vault.sh` places `<stem>.sqlite3` there as
    // `<stem>/vault.db`; the stem is what keeps two fixtures apart here.
    let mut file = "demo-vault.sqlite3".to_owned();
    let mut name = "Demo vault".to_owned();
    let mut wanted = Wanted(None);
    let mut force = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--force" => force = true,
            "--file" => file = args.next().expect("--file takes a name"),
            "--name" => name = args.next().expect("--name takes a display name"),
            "--only" => {
                wanted = Wanted(Some(
                    args.next()
                        .expect("--only takes a comma-separated list")
                        .split(',')
                        .map(|app| app.trim().to_owned())
                        .filter(|app| !app.is_empty())
                        .collect(),
                ));
            }
            // The FIRST bare argument is the directory; a second is a typo, and
            // a fixture generator that silently ignored one would write its
            // vault somewhere the caller is not looking.
            other if dir.is_none() => dir = Some(PathBuf::from(other)),
            other => panic!("seed-demo-vault: unexpected argument {other:?}"),
        }
    }
    Options {
        dir: dir.unwrap_or_else(|| PathBuf::from("/tmp/centraid-demo")),
        file,
        name,
        wanted,
        force,
    }
}

/// The process exit code a refusal leaves.
///
/// Non-zero and its own number, so a script that seeds before it runs a
/// scenario stops rather than carrying on over a vault it did not seed.
const REFUSED: i32 = 2;

/// Refuse a file that is already somebody's vault (#1025 S5).
///
/// Answered by `Vault::vault_id`, which is the vault's own question and needs
/// no SQL here — `sql-confinement` would refuse a query in this crate, and it
/// is right to.
///
/// A file that is NOT a vault is not a refusal: an empty file left by an
/// aborted run, or a path that does not exist, is exactly what this tool is
/// for. What it will not do is delete a founded vault it was not told to.
fn refuse_an_existing_vault(vault_path: &std::path::Path, force: bool) {
    if !vault_path.exists() {
        return;
    }
    let Ok(vault) = Vault::open(vault_path) else {
        // Not a Centraid file at all. The remove below is what it always was.
        return;
    };
    let found = vault.vault_id().ok().flatten();
    // Closed before anything else touches the path: an open handle over a file
    // that is about to be removed is how a `-wal` outlives its database.
    let _ = vault.close();
    let Some(vault_id) = found else {
        return;
    };
    if force {
        eprintln!(
            "seed-demo-vault: --force: overwriting vault {vault_id} at {}",
            vault_path.display()
        );
        return;
    }
    // BY NAME AND LOUDLY. The id is what tells a caller which vault they were
    // about to lose, and the path is what tells them how they got there.
    eprintln!(
        "seed-demo-vault: {} already holds vault {vault_id}.\n\
         This tool DELETES the file it seeds, so running here would destroy that vault \
         and found a new one with a new id.\n\
         Seed somewhere else, or pass --force if that is really what you meant.",
        vault_path.display()
    );
    std::process::exit(REFUSED);
}

fn main() {
    let Options {
        dir,
        file,
        name: vault_name,
        wanted,
        force,
    } = options();
    std::fs::create_dir_all(&dir).expect("the directory is made");
    let vault_path = dir.join(&file);
    // BEFORE A BYTE IS REMOVED. The removal below is unconditional and the
    // founding after it is too, so this is the only place the question can be
    // asked at all (see the module header for the run that proved it).
    refuse_an_existing_vault(&vault_path, force);
    // A FRESH FILE EVERY TIME. A demo vault seeded on top of a previous run's
    // rows has counts nobody can predict, and the counts are what Home draws.
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(dir.join(format!("{file}{suffix}")));
    }
    // AND ITS BYTES. The content store travels with the file it belongs to, so
    // a fresh vault over a previous run's store would dedupe against
    // photographs this run has not seeded yet and report counts nobody can
    // predict — which is the same reason the file itself is removed.
    let bytes_dir = vault_path.with_extension("bytes");
    let _ = std::fs::remove_dir_all(&bytes_dir);

    // WITH THE DEMO WORDS' SEED, so Locker has a `K` to seal under (D-6).
    // Index 0: the one vault the demo words' owner holds.
    let handle = centraid_core::Core::open(
        centraid_core::CoreConfig::new(&vault_path).with_seed(demo_seed(), 0),
    )
    .expect("a core opens");

    // THE ONE CONTENT STORE, SEEDED DIRECTLY (#1025 S3, D-1025-S3-1). A core
    // with no store refuses every photograph by name, so the store is opened
    // here and put on the vault's byte door.
    //
    // The runtime is leaked with the process: this binary seeds and exits, and
    // shutting an iroh store down from a `Drop` that may run on one of its own
    // threads is a deadlock for no gain.
    let runtime = Box::leak(Box::new(
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("a runtime"),
    ));
    let store = runtime
        .block_on(centraid_blobs::ByteStore::open(&bytes_dir))
        .expect("the content store opens");
    // A CLONE KEPT TO CLOSE IT WITH (#1025 S7): iroh-blobs flushes its index
    // on shutdown, and an unflushed index is a store another process resets.
    let to_close = store.clone();
    handle.attach_bytes(centraid_blobs::ContentBytes::new(
        store,
        runtime.handle().clone(),
    ));

    // THE SCENARIO, OUT OF THE LIBRARY. Every app but Locker, in the order the
    // library seeds them, through `Vault::execute`.
    let now = centraid_core::sample::now_ms();
    let mut report = handle
        .with_vault(|vault| {
            let founded = vault.found(&vault_name, "Owner")?;
            let registry = Registry::with_system_commands()?;
            let principal = Principal::owner("demo-device");
            centraid_core::sample::seed(
                vault,
                &registry,
                &principal,
                &founded.owner_party_id,
                &|app| wanted.has(app),
                now,
            )
        })
        .expect("the scenario seeds");
    // LOCKER THROUGH THE SHELL'S DOOR, not `Vault::execute`: sealing is the
    // core's, in `Handle::call`, so these writes need the handle free of the
    // `with_vault` borrow above.
    if wanted.has("locker") {
        report.refused.extend(seed_locker(&handle));
    }
    // WHAT HOME WILL DRAW, READ BACK BEFORE THE HANDLE CLOSES. Each number is
    // the row count of the table that app's Home tile pages (`HomeReads.READS`
    // in `mobile/shared`), read through the same door.
    let seeded =
        SEEDED_TABLES.map(|(app, table, pk, filter)| (app, count_rows(&handle, table, pk, filter)));
    handle.close();
    // AND THE FILE IS FINISHED BEFORE THIS PROCESS GOES (#1020 wave A).
    // `close` leaves the connection to teardown, which is right for a phone
    // and wrong here: `mobile/scripts/demo-vault.sh` copies the `.db` and drops
    // the sidecars, so a vault whose rows sat in its `-wal` was placed empty.
    // `close_file` checkpoints the WAL and removes both sidecars.
    handle
        .close_file()
        .expect("the vault file closes, so the artifact is the whole vault");
    // THE STORE IS FLUSHED BEFORE THIS PROCESS GOES. See the clone above.
    runtime.block_on(to_close.close());

    println!("CENTRAID_VAULT={}", vault_path.display());
    println!("CENTRAID_VAULT_NAME={vault_name}");
    println!("CENTRAID_DEMO_WORDS={DEMO_WORDS}");
    // THE SAME WORDS' 64-BYTE SEED, as the hex a phone's secure store holds
    // (`CONTRACT.md` §4b). A shell has no BIP-39 of its own, so a debug build
    // takes this at launch (`mobile/scripts/demo-vault.sh`, #1047 W2). It is
    // the public all-`abandon` vector's seed, never anybody's.
    let seed_hex: String = demo_seed()
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    println!("CENTRAID_DEMO_SEED={seed_hex}");
    let counts: Vec<String> = seeded
        .iter()
        .map(|(app, rows)| format!("{app}={rows}"))
        .collect();
    println!("CENTRAID_SEEDED {}", counts.join(" "));
    for gap in &report.gaps {
        println!(
            "CENTRAID_GAP={gap} — registered with no body yet, so the app it belongs to seeds nothing"
        );
    }
    if report.refused.is_empty() {
        println!("CENTRAID_REFUSED=0");
    } else {
        // NON-ZERO EXIT ON A PARTIAL SEED. A demo vault that is quietly missing
        // an app is the thing this whole binary exists to stop being invisible.
        println!("CENTRAID_REFUSED={}", report.refused.len());
        for line in &report.refused {
            println!("  {line}");
        }
        std::process::exit(1);
    }
}

/// Each app, the table its Home tile pages, that table's primary key and the
/// tile's filter — the `from`, the `pk_column` and the `where` of
/// `HomeReads.READS`, in its order. People pages `core_party` for the parties
/// with a live `people_profile` (#1047), so its mirror counts the profiles —
/// this seeder trashes none, so every profile is live. Locker counts live,
/// unarchived items, as its tile does; the trashed demo item is not one.
const SEEDED_TABLES: [(&str, &str, &str, Option<&str>); 8] = [
    ("photos", "media_asset", "asset_id", None),
    ("docs", "core_document", "document_id", None),
    ("notes", "knowledge_note", "note_id", None),
    ("agenda", "core_event", "event_id", None),
    ("tasks", "schedule_task", "task_id", None),
    ("people", "people_profile", "profile_id", None),
    ("tally", "tally_group", "group_id", None),
    (
        "locker",
        "locker_item",
        "item_id",
        Some("deleted_at IS NULL AND archived_at IS NULL"),
    ),
];

/// Every row of a table, counted by paging it through the read door to the end.
///
/// There is no `COUNT(*)` on the door and `sql-confinement` refuses SQL here
/// (see [`first_row`]), so the count is the rows the pages hand back — which is
/// also exactly how a Home tile arrives at its number.
fn count_rows(
    handle: &centraid_core::Handle,
    table: &str,
    pk: &str,
    filter: Option<&str>,
) -> usize {
    let mut rows = 0;
    let mut after = None;
    loop {
        let request = wire::Request {
            kind: Some(wire::request::Kind::Page(wire::PageRequest {
                query: Some(wire::PageQuery {
                    name: "seed.count".to_owned(),
                    select: vec![pk.to_owned()],
                    from: table.to_owned(),
                    r#where: filter.map(str::to_owned),
                    bind: Vec::new(),
                    order: Some(wire::PageOrder {
                        sort_column: pk.to_owned(),
                        pk_column: pk.to_owned(),
                        descending: false,
                    }),
                    with_held_thumbnail: false,
                    with_note_body: false,
                    with_document_size: false,
                    with_minor_units: false,
                    local_day_columns: Vec::new(),
                    tz: String::new(),
                }),
                limit: 500,
                after,
            })),
        };
        let response = handle
            .call(&request)
            .unwrap_or_else(|refusal| panic!("counting {table} was refused: {refusal:?}"));
        let Some(wire::response::Kind::Page(page)) = response.kind else {
            panic!("counting {table} did not answer with a page");
        };
        rows += page.rows.len();
        match page.next {
            Some(next) => after = Some(next),
            None => return rows,
        }
    }
}

// ---------------------------------------------------------------------------
// Locker.
//
// "A few saved things for the trip, one of them overdue for a change."
// ---------------------------------------------------------------------------

/// The demo's 24 words: the public BIP39 all-`abandon` vector, so nobody
/// mistakes them for a member's. A phone opened with them reveals what this
/// seed sealed.
const DEMO_WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
abandon abandon abandon abandon abandon art";

fn demo_seed() -> centraid_core::Seed {
    centraid_identity::RecoveryPhrase::parse(DEMO_WORDS)
        .expect("the demo words are a valid phrase")
        .seed()
}

/// The Locker items, each with the secrets the core seals on the way in.
///
/// One of each thing a member walks: a login with a password and an address,
/// a card, a secure note, a Wi-Fi password, a login Review flags (marked
/// compromised, on `http://`), one item in the trash, a sealed and a plain
/// custom field on the bank login, and a login holding a passkey (#1047 T2).
/// Every secret is a test value.
fn locker_items() -> Vec<(&'static str, Value)> {
    vec![
        (
            "locker.add_item",
            json!({
                "item_id": "demo-locker-bank", "type": "login", "title": "Sierra Credit Union",
                "username": "owner@example.com", "password": "Granite-Lake-47-Pine",
                "url": "https://sierracu.example.com", "tags": ["finance"],
                "notes": "Joint account for the cabin fund.",
                // RFC 6238 Appendix B's own seed, as the QR code a bank shows
                // would carry it, so the item page's code can be checked
                // against any authenticator (Q-1047-16).
                "otp_seed": "otpauth://totp/Sierra%20Credit%20Union:owner?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Sierra%20Credit%20Union"
            }),
        ),
        (
            "locker.add_item",
            json!({
                "item_id": "demo-locker-card", "type": "card", "title": "Travel Visa",
                "cardholder": "Demo Owner", "card_number": "4111111111111111",
                "expiry": "09/31", "cvv": "123", "brand": "Visa"
            }),
        ),
        (
            "locker.add_item",
            json!({
                "item_id": "demo-locker-cabin", "type": "note", "title": "Tahoe cabin door",
                "content": "Keypad 4417#. The spare key is under the blue planter."
            }),
        ),
        (
            "locker.add_item",
            json!({
                "item_id": "demo-locker-wifi", "type": "wifi", "title": "Cabin Wi-Fi",
                "network": "tahoe-cabin", "password": "snowmelt-2024"
            }),
        ),
        (
            "locker.add_item",
            json!({
                "item_id": "demo-locker-forum", "type": "login", "title": "Old ski forum",
                "username": "owner", "password": "tahoe2019",
                "url": "http://skiforum.example.org", "compromised": true
            }),
        ),
        (
            "locker.add_item",
            json!({
                "item_id": "demo-locker-gone", "type": "password", "title": "Old router",
                "password": "admin1234"
            }),
        ),
        (
            "locker.trash_item",
            json!({ "item_id": "demo-locker-gone" }),
        ),
        ("locker.star_item", json!({ "item_id": "demo-locker-bank" })),
        // CUSTOM FIELDS (#1047 T2): a sealed one the core seals against its
        // own id, and a plain one, so the item page shows both kinds.
        (
            "locker.set_field",
            json!({
                "item_id": "demo-locker-bank", "field_id": "demo-locker-bank-recovery",
                "section": "Recovery", "label": "Recovery code", "kind": "sealed",
                "value": "SCU-7731-4402-9918", "position": 0
            }),
        ),
        (
            "locker.set_field",
            json!({
                "item_id": "demo-locker-bank", "field_id": "demo-locker-bank-member",
                "section": "Recovery", "label": "Member number", "kind": "text",
                "value": "0048213", "position": 1
            }),
        ),
        // A LOGIN THAT HOLDS A PASSKEY (#1047 T2). Its key material is sealed
        // by `seed_passkey` below, because no phone door takes one.
        (
            "locker.add_item",
            json!({
                "item_id": "demo-locker-rentals", "type": "login", "title": "Alpine Rentals",
                "username": "owner@example.com", "url": "https://alpinerentals.example.com"
            }),
        ),
    ]
}

/// THE DEMO PASSKEY'S KEY, SEALED HERE (#1047 T2, L-passkey). A passkey is
/// storage only and no phone door takes key material — the phone neither makes
/// nor imports one — so the seeder seals the demo's under the demo words' `K`
/// itself, against the item's id, exactly as the vault stores one. The value
/// is a test string, not a key anybody signs with.
fn seed_passkey(handle: &centraid_core::Handle) -> Result<(), String> {
    let keys = centraid_core::phone::Keyring::derive(&demo_seed(), 0, None)
        .map_err(|error| error.to_string())?;
    let key_id = handle
        .with_vault(|vault| {
            vault
                .locker_generation()
                .map_err(|error| centraid_core::CoreError::Invariant {
                    context: error.to_string(),
                })
        })
        .map_err(|error| error.to_string())?;
    let sealed = centraid_vault::custody::encrypt_under_locker_key(
        keys.vault.locker.as_bytes(),
        &key_id,
        "demo-locker-rentals",
        "demo-passkey-es256-private-key",
    )
    .map_err(|error| error.to_string())?;
    let input = json!({
        "item_id": "demo-locker-rentals", "rp_id": "alpinerentals.example.com",
        "user_handle": "owner", "display_name": "Cabin booking", "credential_id": "demo-credential-1",
        "algorithm": "ES256", "private_key": sealed, "key_id": key_id
    });
    let answer = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Command(wire::Command {
                name: "locker.set_passkey".to_owned(),
                input: serde_json::to_vec(&input).map_err(|error| error.to_string())?,
                invoke_key: "seed-demo-locker-passkey".to_owned(),
                ..wire::Command::default()
            })),
        })
        .map_err(|error| error.to_string())?;
    match answer.kind {
        Some(wire::response::Kind::Command(outcome))
            if outcome.status == wire::CommandStatus::Executed as i32 =>
        {
            Ok(())
        }
        Some(wire::response::Kind::Command(outcome)) => Err(outcome.reason),
        other => Err(format!("answered as {other:?}")),
    }
}

/// Seed Locker through `Handle::call`: unlock, write, relock. Answers the
/// refusals, in the report's words.
fn seed_locker(handle: &centraid_core::Handle) -> Vec<String> {
    use wire::locker_session_request::Step;
    let session = |step: Step| {
        handle.call(&wire::Request {
            kind: Some(wire::request::Kind::Locker(wire::LockerSessionRequest {
                step: Some(step),
            })),
        })
    };
    let mut refused = Vec::new();
    if let Err(error) = session(Step::Unlock(wire::LockerUnlock {})) {
        eprintln!("seed-demo-vault: locker unlock refused: {error}");
        refused.push(format!("locker.unlock: {error}"));
        return refused;
    }
    for (index, (name, input)) in locker_items().into_iter().enumerate() {
        let answer = handle.call(&wire::Request {
            kind: Some(wire::request::Kind::Command(wire::Command {
                name: name.to_owned(),
                input: serde_json::to_vec(&input).expect("a seed input is JSON"),
                invoke_key: format!("seed-demo-locker-{index}"),
                ..wire::Command::default()
            })),
        });
        let why = match answer.map(|response| response.kind) {
            Ok(Some(wire::response::Kind::Command(outcome)))
                if outcome.status == wire::CommandStatus::Executed as i32 =>
            {
                continue;
            }
            Ok(Some(wire::response::Kind::Command(outcome))) => outcome.reason,
            Ok(other) => format!("answered as {other:?}"),
            Err(error) => error.to_string(),
        };
        eprintln!("seed-demo-vault: {name} refused: {why}");
        refused.push(format!("{name}: {why}"));
    }
    if let Err(why) = seed_passkey(handle) {
        eprintln!("seed-demo-vault: locker.set_passkey refused: {why}");
        refused.push(format!("locker.set_passkey: {why}"));
    }
    // LOCKED AGAIN, so nothing about the artifact depends on a session.
    if let Err(error) = session(Step::Relock(wire::LockerRelock {})) {
        refused.push(format!("locker.relock: {error}"));
    }
    refused
}
