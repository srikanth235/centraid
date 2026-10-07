//! Locker's arm and its session, through `Handle::call` — the door a shell uses
//! — over items written by the real `locker.*` commands (#1047, D-5).

use super::*;
use crate::config::CoreConfig;
use crate::handle::{Core, Handle};
use prost::Message as _;
use serde_json::json;
use wire::app_query_request::Query as Q;
use wire::locker_session_request::Step;

/// 02:00Z on 1 July is still 30 June in New York.
const NOW: &str = "2099-07-01T02:00:00.000Z";
const TZ: &str = "America/New_York";
const PASSWORD: &str = "correct horse battery staple";

struct Scratch {
    dir: std::path::PathBuf,
    handle: Handle,
    writes: std::cell::Cell<u32>,
}

/// The member's 24 words (the BIP39 all-`abandon` vector).
const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
     abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
     abandon abandon abandon abandon abandon art";
/// Somebody else's 24 words.
const OTHER_WORDS: &str = "legal winner thank year wave sausage worth useful legal winner \
     thank year wave sausage worth useful legal winner thank year wave sausage worth title";

fn seed_of(words: &str) -> centraid_identity::Seed {
    centraid_identity::RecoveryPhrase::parse(words)
        .expect("the words parse")
        .seed()
}

fn open_at(path: std::path::PathBuf, seed: Option<centraid_identity::Seed>) -> Handle {
    let now = centraid_vault::time::recurrence::parse_instant_ms(NOW).expect("an instant");
    let config = CoreConfig::new(path).with_clock(
        std::sync::Arc::new(centraid_vault::clock::FixedClock::at(now)),
        std::sync::Arc::new(centraid_vault::clock::ClockIds::new(Box::new(
            centraid_vault::clock::FixedClock::at(now),
        ))),
    );
    let config = match seed {
        Some(seed) => config.with_seed(seed, 0),
        None => config,
    };
    Core::open(config).expect("it opens")
}

impl Scratch {
    fn founded() -> Self {
        Self::founded_with(Some(seed_of(WORDS)))
    }

    fn founded_with(seed: Option<centraid_identity::Seed>) -> Self {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let handle = open_at(dir.join("vault.db"), seed);
        handle
            .with_vault(|vault| Ok(vault.found("Locker", "Owner")?))
            .expect("it founds");
        Self {
            dir,
            handle,
            writes: std::cell::Cell::new(0),
        }
    }

    /// THE RESTORE'S SHAPE: the vault file alone, as a backup carries it, in
    /// a directory of its own, opened by a core holding `words`' seed. No key
    /// directory travels, because there is none.
    fn restored(&self, words: &str) -> Self {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the directory is made");
        // The file and its write-ahead log, which SQLite folds in on open;
        // nothing writes while the copy is taken.
        for name in ["vault.db", "vault.db-wal"] {
            let from = self.dir.join(name);
            if from.exists() {
                std::fs::copy(&from, dir.join(name)).expect("the vault file copies");
            }
        }
        Self {
            handle: open_at(dir.join("vault.db"), Some(seed_of(words))),
            dir,
            writes: std::cell::Cell::new(0),
        }
    }

    fn ask(&self, query: Q) -> Answer {
        match self
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::AppQuery(wire::AppQueryRequest {
                    query: Some(query),
                })),
            })
            .expect("the query answers")
            .kind
        {
            Some(wire::response::Kind::AppQuery(answer)) => {
                answer.answer.expect("an app query is answered")
            }
            other => panic!("an app query answered as {other:?}"),
        }
    }

    /// The raw bytes of an answer, to search for what must never be in one.
    fn ask_bytes(&self, query: Q) -> Vec<u8> {
        wire::AppQueryResponse {
            answer: Some(self.ask(query)),
        }
        .encode_to_vec()
    }

    fn session(&self, step: Step) -> wire::LockerSessionResponse {
        match self
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Locker(wire::LockerSessionRequest {
                    step: Some(step),
                })),
            })
            .expect("the session answers")
            .kind
        {
            Some(wire::response::Kind::Locker(answer)) => answer,
            other => panic!("a session step answered as {other:?}"),
        }
    }

    fn unlock(&self) -> wire::LockerSessionResponse {
        self.session(Step::Unlock(wire::LockerUnlock {}))
    }

    fn relock(&self) -> wire::LockerSessionResponse {
        self.session(Step::Relock(wire::LockerRelock {}))
    }

    fn reveal(&self, item_id: &str, column: &str) -> wire::LockerSessionResponse {
        self.session(Step::Reveal(wire::LockerReveal {
            item_id: item_id.to_owned(),
            column: column.to_owned(),
            ..wire::LockerReveal::default()
        }))
    }

    fn totp(&self, item_id: &str) -> wire::LockerSessionResponse {
        self.session(Step::Totp(wire::LockerTotpAsk {
            item_id: item_id.to_owned(),
            ..wire::LockerTotpAsk::default()
        }))
    }

    fn try_run(&self, name: &str, input: serde_json::Value) -> Result<serde_json::Value> {
        self.writes.set(self.writes.get() + 1);
        let response = self.handle.call(&wire::Request {
            kind: Some(wire::request::Kind::Command(wire::Command {
                name: name.to_owned(),
                input: serde_json::to_vec(&input).expect("json"),
                invoke_key: format!("locker-query-test-{}", self.writes.get()),
                ..wire::Command::default()
            })),
        })?;
        let Some(wire::response::Kind::Command(outcome)) = response.kind else {
            panic!("a command answered with something else");
        };
        assert_eq!(
            outcome.status,
            wire::CommandStatus::Executed as i32,
            "{name}: {}",
            outcome.reason
        );
        Ok(serde_json::from_slice(&outcome.output).expect("the output is JSON"))
    }

    fn run(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
        self.try_run(name, input)
            .unwrap_or_else(|error| panic!("{name} refused: {error}"))
    }

    fn items(&self, archived: bool) -> wire::LockerItems {
        match self.ask(Q::LockerItems(wire::LockerItemsRequest {
            archived,
            limit: 0,
            tz: TZ.to_owned(),
        })) {
            Answer::LockerItems(items) => items,
            other => panic!("items answered as {other:?}"),
        }
    }

    fn item(&self, item_id: &str) -> Option<wire::LockerItem> {
        match self.ask(Q::LockerItem(wire::LockerItemRequest {
            item_id: item_id.to_owned(),
            tz: TZ.to_owned(),
        })) {
            Answer::LockerItem(detail) => detail.item,
            other => panic!("item answered as {other:?}"),
        }
    }

    fn search(&self, term: &str) -> wire::LockerSearch {
        match self.ask(Q::LockerSearch(wire::LockerSearchRequest {
            term: term.to_owned(),
            limit: 0,
            tz: TZ.to_owned(),
        })) {
            Answer::LockerSearch(search) => search,
            other => panic!("search answered as {other:?}"),
        }
    }

    fn stored_password(&self, item_id: &str) -> Option<String> {
        self.handle
            .with_vault(|vault| Ok(vault.locker_sealed_item_cell(item_id, "password")?))
            .expect("the cell reads")
            .and_then(|cell| cell.ciphertext)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle.as_bytes())
}

/// A locker with one of each kind of thing a list must tell apart.
fn stocked() -> Scratch {
    let scratch = Scratch::founded();
    scratch.unlock();
    scratch.run(
        "locker.add_item",
        json!({
            "item_id": "item-bank", "type": "login", "title": "Bank",
            "username": "maya@example.com", "password": PASSWORD,
            "url": "https://bank.example.com", "notes": "recovery words live here",
            "tags": ["finance"]
        }),
    );
    scratch.run(
        "locker.add_item",
        json!({ "item_id": "item-forum", "type": "login", "title": "Old forum",
                "username": "maya", "url": "http://forum.example.org", "compromised": true }),
    );
    scratch.run(
        "locker.add_item",
        json!({ "item_id": "item-card", "type": "card", "title": "Visa",
                "cardholder": "Maya", "expiry": "12/99", "card_number": "4111111111111111" }),
    );
    scratch.run(
        "locker.add_item",
        json!({ "item_id": "item-old-card", "type": "card", "title": "Expired Visa",
                "expiry": "01/99" }),
    );
    scratch.run(
        "locker.add_item",
        json!({ "item_id": "item-wifi", "type": "wifi", "title": "Home Wi-Fi",
                "network": "casa" }),
    );
    scratch.run(
        "locker.add_item",
        json!({ "item_id": "item-archived", "type": "note", "title": "Old note" }),
    );
    scratch.run("locker.archive_item", json!({ "item_id": "item-archived" }));
    scratch.run(
        "locker.add_item",
        json!({ "item_id": "item-trashed", "type": "password", "title": "Gone" }),
    );
    scratch.run("locker.trash_item", json!({ "item_id": "item-trashed" }));
    scratch.run("locker.star_item", json!({ "item_id": "item-bank" }));
    scratch.relock();
    scratch
}

#[test]
fn the_shelf_is_metadata_with_the_vaults_own_counts() {
    let scratch = stocked();
    let items = scratch.items(false);
    let ids: Vec<&str> = items.items.iter().map(|row| row.item_id.as_str()).collect();
    assert_eq!(ids.len(), 5, "live only: {ids:?}");
    assert!(!ids.contains(&"item-archived") && !ids.contains(&"item-trashed"));
    assert_eq!(items.total, Some(5));
    assert_eq!(items.archived_count, Some(1));
    assert_eq!(items.trashed_count, Some(1));
    assert!(!items.truncated);
    assert_eq!(items.tags, vec!["finance".to_owned()]);
    assert_eq!(
        items.today, "2099-06-30",
        "today is the device's, not UTC's"
    );
    let bank = items
        .items
        .iter()
        .find(|row| row.item_id == "item-bank")
        .expect("bank");
    assert!(bank.starred);
    assert_eq!(bank.subtitle, "maya@example.com");
    assert_eq!(bank.url, "https://bank.example.com");
    assert_eq!(bank.updated_local_day, "2099-06-30");
    let card = items
        .items
        .iter()
        .find(|row| row.item_id == "item-card")
        .expect("card");
    assert_eq!(card.r#type, "card");
    assert_eq!(
        card.subtitle, "Card",
        "a card's number never makes a subtitle"
    );
    let counts: Vec<(&str, u32)> = items
        .by_type
        .iter()
        .map(|count| (count.r#type.as_str(), count.count))
        .collect();
    assert_eq!(counts, vec![("login", 2), ("card", 2), ("wifi", 1)]);
    let archived = scratch.items(true);
    assert_eq!(archived.items.len(), 1);
    assert!(archived.items[0].archived);
}

#[test]
fn no_answer_carries_a_secret_or_its_ciphertext() {
    let scratch = stocked();
    let stored = scratch
        .stored_password("item-bank")
        .expect("a password is stored");
    assert!(stored.starts_with("lk1:"), "sealed at rest: {stored}");
    for bytes in [
        scratch.ask_bytes(Q::LockerItems(wire::LockerItemsRequest {
            tz: TZ.to_owned(),
            ..wire::LockerItemsRequest::default()
        })),
        scratch.ask_bytes(Q::LockerItem(wire::LockerItemRequest {
            item_id: "item-bank".to_owned(),
            tz: TZ.to_owned(),
        })),
        scratch.ask_bytes(Q::LockerItem(wire::LockerItemRequest {
            item_id: "item-card".to_owned(),
            tz: TZ.to_owned(),
        })),
        scratch.ask_bytes(Q::LockerSearch(wire::LockerSearchRequest {
            term: "a".to_owned(),
            tz: TZ.to_owned(),
            ..wire::LockerSearchRequest::default()
        })),
        scratch.ask_bytes(Q::LockerReview(wire::LockerReviewRequest {
            tz: TZ.to_owned(),
        })),
    ] {
        assert!(!contains(&bytes, PASSWORD), "a password rode an answer");
        assert!(
            !contains(&bytes, "4111111111111111"),
            "a card number rode an answer"
        );
        assert!(!contains(&bytes, "lk1:"), "ciphertext rode an answer");
    }
}

#[test]
fn an_item_answers_its_secrets_as_presence_and_its_sidecars() {
    let scratch = stocked();
    scratch.run(
        "locker.set_memo",
        json!({ "item_id": "item-bank", "note": "Branch on Elm St" }),
    );
    let bank = scratch.item("item-bank").expect("the bank login");
    assert_eq!(bank.r#type, "login");
    assert_eq!(bank.username, "maya@example.com");
    assert_eq!(bank.memo, "Branch on Elm St");
    assert_eq!(bank.tags, vec!["finance".to_owned()]);
    assert!(bank.starred && !bank.trashed && !bank.archived);
    let secrets: Vec<(&str, bool)> = bank
        .secrets
        .iter()
        .map(|secret| (secret.column.as_str(), secret.present))
        .collect();
    assert_eq!(secrets, vec![("password", true), ("otp_seed", false)]);
    assert_eq!(bank.password_set_local_day, "2099-06-30");
    let card = scratch.item("item-card").expect("the card");
    let secrets: Vec<(&str, bool)> = card
        .secrets
        .iter()
        .map(|secret| (secret.column.as_str(), secret.present))
        .collect();
    assert_eq!(secrets, vec![("card_number", true), ("cvv", false)]);
    let trashed = scratch
        .item("item-trashed")
        .expect("a trashed item still answers");
    assert!(trashed.trashed);
    assert!(!trashed.purge_local_day.is_empty());
    assert!(scratch.item("no-such-item").is_none());
}

#[test]
fn search_is_title_username_and_address_and_never_a_note_or_a_secret() {
    let scratch = stocked();
    let hits = |term: &str| -> Vec<String> {
        scratch
            .search(term)
            .items
            .into_iter()
            .map(|row| row.item_id)
            .collect()
    };
    assert_eq!(hits("bank"), vec!["item-bank".to_owned()]);
    assert_eq!(hits("MAYA@"), vec!["item-bank".to_owned()]);
    assert_eq!(hits("forum.example"), vec!["item-forum".to_owned()]);
    assert!(hits("recovery").is_empty(), "notes are not searched");
    assert!(hits("battery").is_empty(), "a password is not searched");
    assert!(hits("gone").is_empty(), "the trash is not searched");
    assert_eq!(hits("old note"), vec!["item-archived".to_owned()]);
    assert!(hits("   ").is_empty());
}

#[test]
fn review_names_what_metadata_can_show() {
    let scratch = stocked();
    let Answer::LockerReview(review) = scratch.ask(Q::LockerReview(wire::LockerReviewRequest {
        tz: TZ.to_owned(),
    })) else {
        panic!("review answered as something else");
    };
    let ids = |rows: &[wire::LockerItemRow]| -> Vec<String> {
        rows.iter().map(|row| row.item_id.clone()).collect()
    };
    assert_eq!(ids(&review.compromised), vec!["item-forum".to_owned()]);
    assert_eq!(ids(&review.insecure_address), vec!["item-forum".to_owned()]);
    assert_eq!(ids(&review.expired), vec!["item-old-card".to_owned()]);
    assert!(
        review.expiring.is_empty(),
        "12/99 is not within two months of June"
    );
    assert_eq!(review.reviewed, 6, "live and archived, not trashed");
    assert_eq!(review.today, "2099-06-30");
}

#[test]
fn a_secret_is_sealed_only_while_the_session_is_open() {
    let scratch = Scratch::founded();
    assert_eq!(
        scratch.session(Step::State(wire::LockerStateAsk {})).state,
        wire::LockerSessionState::Locked as i32,
        "a phone's Locker boots locked"
    );
    let refused = scratch.try_run(
        "locker.add_item",
        json!({ "item_id": "item-1", "type": "login", "title": "Bank", "password": PASSWORD }),
    );
    assert!(
        matches!(refused, Err(CoreError::InvalidRequest { .. })),
        "a locked Locker seals nothing: {refused:?}"
    );
    // METADATA NEEDS NO KEY: a login with no password saves while locked.
    scratch.run(
        "locker.add_item",
        json!({ "item_id": "item-2", "type": "login", "title": "Forum", "username": "maya" }),
    );
    let unlocked = scratch.unlock();
    assert_eq!(unlocked.state, wire::LockerSessionState::Unlocked as i32);
    assert!(unlocked.remaining_ms > 0);
    assert!(!unlocked.receipt_id.is_empty(), "the unlock is receipted");
    scratch.run(
        "locker.add_item",
        json!({ "item_id": "item-1", "type": "login", "title": "Bank", "password": PASSWORD }),
    );
    let stored = scratch.stored_password("item-1").expect("stored");
    assert!(stored.starts_with("lk1:") && !stored.contains(PASSWORD));
    // `K` IS THE SEED'S LEAF, NEVER A FILE (Q-1047-11): nothing beside the
    // vault holds a key.
    assert!(
        !scratch.dir.join("keys").exists(),
        "no key directory is made beside the vault"
    );
    // AND NO FILE HOLDS `K` AT ALL (#1047 L5). After an unlock, a seal, a
    // reveal and a relock, every file under the vault's directory — the vault,
    // its `-wal` and `-shm`, and whatever else is there — is read whole and
    // searched for `K`'s 32 raw bytes and for its hex. What this proves is
    // bounded by those two encodings and that directory; it says nothing of
    // swap or of a core dump.
    assert_eq!(
        scratch
            .reveal("item-1", "password")
            .revealed
            .map(|r| r.value),
        Some(PASSWORD.to_owned())
    );
    scratch.relock();
    let k = centraid_identity::derive::restore_vault_keys(&seed_of(WORDS), 0)
        .expect("the words derive")
        .locker;
    let raw = k.as_bytes().to_vec();
    let hex_k = hex::encode(&raw).into_bytes();
    let mut stack = vec![scratch.dir.clone()];
    let mut read = 0;
    while let Some(at) = stack.pop() {
        for entry in std::fs::read_dir(&at).expect("the directory reads") {
            let path = entry.expect("an entry").path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let bytes = std::fs::read(&path).expect("a file reads");
            read += 1;
            for needle in [&raw, &hex_k] {
                assert!(
                    !bytes
                        .windows(needle.len())
                        .any(|window| window == needle.as_slice()),
                    "`K` is on disk in {}",
                    path.display()
                );
            }
        }
    }
    assert!(read > 0, "the scan read no file, so it proved nothing");
}

/// A CORE OPENED WITHOUT THE SEED HAS NO `K`, and says so rather than minting
/// a stand-in (Q-1047-11).
#[test]
fn a_core_without_the_seed_cannot_open_locker() {
    let scratch = Scratch::founded_with(None);
    let refused = scratch.handle.call(&wire::Request {
        kind: Some(wire::request::Kind::Locker(wire::LockerSessionRequest {
            step: Some(Step::Unlock(wire::LockerUnlock {})),
        })),
    });
    assert!(
        matches!(refused, Err(CoreError::Unavailable { .. })),
        "{refused:?}"
    );
    assert!(!scratch.dir.join("keys").exists());
}

/// THE 24 WORDS CARRY THE LOCKER (#1047, Q-1047-11): the vault file restored
/// under the same words reveals what was sealed on the lost phone, and under
/// anybody else's words it does not.
#[test]
fn a_restore_from_the_same_words_reopens_sealed_secrets() {
    let lost = stocked();
    let restored = lost.restored(WORDS);
    restored.unlock();
    assert_eq!(
        restored
            .reveal("item-bank", "password")
            .revealed
            .expect("the restored phone opens what the lost one sealed")
            .value,
        PASSWORD
    );
    // …and it keeps sealing under the same generation.
    restored.run(
        "locker.edit_item",
        json!({ "item_id": "item-bank", "title": "Bank", "username": "maya@example.com",
                "url": "https://bank.example.com", "password": "after the restore" }),
    );
    assert_eq!(
        restored
            .reveal("item-bank", "password")
            .revealed
            .expect("it reveals")
            .value,
        "after the restore"
    );

    let stranger = lost.restored(OTHER_WORDS);
    stranger.unlock();
    let refused = stranger.reveal("item-bank", "password");
    assert!(refused.revealed.is_none());
    assert_eq!(
        refused.refusal,
        wire::LockerRevealRefusal::DidNotOpen as i32,
        "another person's words derive another `K`"
    );
}

#[test]
fn a_reveal_is_receipted_opens_the_cell_and_is_refused_once_relocked() {
    let scratch = stocked();
    let locked = scratch.reveal("item-bank", "password");
    assert_eq!(
        locked.refusal,
        wire::LockerRevealRefusal::Locked as i32,
        "locked is a refusal, never a prompt"
    );
    assert!(locked.revealed.is_none());
    scratch.unlock();
    let answer = scratch.reveal("item-bank", "password");
    let revealed = answer.revealed.expect("it revealed");
    assert_eq!(revealed.value, PASSWORD);
    assert!(!revealed.receipt_id.is_empty());
    assert_eq!(revealed.expires_in_ms, 30_000);
    let card = scratch
        .reveal("item-card", "card_number")
        .revealed
        .expect("card");
    assert_eq!(card.value, "4111111111111111");
    assert_eq!(
        scratch.reveal("item-card", "cvv").refusal,
        wire::LockerRevealRefusal::Empty as i32
    );
    assert_eq!(
        scratch.reveal("item-bank", "username").refusal,
        wire::LockerRevealRefusal::NotSealed as i32,
        "a plain column is not revealed"
    );
    assert_eq!(
        scratch.reveal("item-trashed", "password").refusal,
        wire::LockerRevealRefusal::NotSealed as i32,
        "a trashed item's cells stop revealing with it"
    );
    let relocked = scratch.relock();
    assert_eq!(relocked.state, wire::LockerSessionState::Locked as i32);
    assert_eq!(
        scratch.reveal("item-bank", "password").refusal,
        wire::LockerRevealRefusal::Locked as i32
    );
    // THE SAME GENERATION COMES BACK on the next unlock: nothing was re-minted.
    scratch.unlock();
    assert_eq!(
        scratch
            .reveal("item-bank", "password")
            .revealed
            .expect("again")
            .value,
        PASSWORD
    );
}

#[test]
fn an_edit_says_whether_the_password_changed_because_only_the_core_can_tell() {
    let scratch = stocked();
    scratch.unlock();
    let set_on = |scratch: &Scratch| {
        scratch
            .item("item-bank")
            .expect("bank")
            .password_set_local_day
    };
    assert_eq!(set_on(&scratch), "2099-06-30");
    let edit = |password: &str| {
        scratch.run(
            "locker.edit_item",
            json!({ "item_id": "item-bank", "title": "Bank", "username": "maya@example.com",
                    "url": "https://bank.example.com", "password": password }),
        )
    };
    let same = edit(PASSWORD);
    assert_eq!(
        same["rotated"],
        json!(false),
        "a re-typed password is not a rotation"
    );
    let changed = edit("a brand new passphrase");
    assert_eq!(changed["rotated"], json!(true));
    assert_eq!(
        scratch
            .reveal("item-bank", "password")
            .revealed
            .expect("it reveals")
            .value,
        "a brand new passphrase"
    );
    // THE PLACEHOLDER LEAVES THE SECRET ALONE, and needs no key.
    scratch.relock();
    scratch.run(
        "locker.edit_item",
        json!({ "item_id": "item-bank", "title": "My bank", "username": "maya@example.com",
                "url": "https://bank.example.com", "password": "«sealed»" }),
    );
    scratch.unlock();
    assert_eq!(
        scratch
            .reveal("item-bank", "password")
            .revealed
            .expect("still there")
            .value,
        "a brand new passphrase"
    );
}

/// MARKED BY HAND, ANSWERED BY A NEW PASSWORD (#1047, R-1047-F7): the member
/// flags a leaked secret through `locker.edit_item`, Review lists it, and the
/// edit that changes the password — `password_rotated` decided by the core,
/// which alone can compare — clears it. Re-typing the same password does not.
#[test]
fn a_flagged_item_is_listed_for_review_until_its_password_changes() {
    let scratch = stocked();
    scratch.unlock();
    let listed = |scratch: &Scratch| -> Vec<String> {
        let Answer::LockerReview(review) =
            scratch.ask(Q::LockerReview(wire::LockerReviewRequest {
                tz: TZ.to_owned(),
            }))
        else {
            panic!("review answered as something else");
        };
        let mut ids: Vec<String> = review
            .compromised
            .iter()
            .map(|row| row.item_id.clone())
            .collect();
        ids.sort();
        ids
    };
    let edit = |password: &str, extra: serde_json::Value| {
        let mut input = json!({ "item_id": "item-bank", "title": "Bank",
            "username": "maya@example.com", "url": "https://bank.example.com",
            "password": password });
        for (key, value) in extra.as_object().expect("an object") {
            input[key] = value.clone();
        }
        scratch.run("locker.edit_item", input)
    };
    assert_eq!(listed(&scratch), vec!["item-forum".to_owned()]);

    edit("«sealed»", json!({ "compromised": true }));
    assert!(scratch.item("item-bank").expect("bank").compromised);
    assert_eq!(
        listed(&scratch),
        vec!["item-bank".to_owned(), "item-forum".to_owned()]
    );

    edit(PASSWORD, json!({}));
    assert!(
        scratch.item("item-bank").expect("bank").compromised,
        "the same password re-typed is not the fix"
    );

    let changed = edit("a password nobody has seen", json!({}));
    assert_eq!(changed["rotated"], json!(true));
    assert!(!scratch.item("item-bank").expect("bank").compromised);
    assert_eq!(listed(&scratch), vec!["item-forum".to_owned()]);
}

/// A ONE-TIME CODE ON THE PHONE (Q-1047-16): the seed a member pasted — an
/// `otpauth://` link here — is read once and sealed as base32; a code is
/// refused while locked, receipted through `locker.totp_code` before it
/// exists, and is the RFC 6238 code for the vault clock's instant; the seed
/// itself never comes back, not even to a reveal that names its cell.
#[test]
fn a_one_time_code_is_receipted_first_and_is_rfc_6238s_code_for_now() {
    let scratch = Scratch::founded();
    scratch.unlock();
    // The RFC 6238 Appendix B seed, as the QR code a site shows would carry it.
    scratch.run(
        "locker.add_item",
        json!({ "item_id": "item-otp", "type": "login", "title": "Bank",
                "otp_seed": "otpauth://totp/Bank:maya?secret=gezd-gnbv-gy3t-qojq-gezd-gnbv-gy3t-qojq&issuer=Bank" }),
    );
    scratch.run(
        "locker.add_item",
        json!({ "item_id": "item-plain", "type": "login", "title": "Forum", "username": "maya" }),
    );
    let refused = scratch.try_run(
        "locker.add_item",
        json!({ "item_id": "item-bad", "type": "login", "title": "Shop",
                "otp_seed": "otpauth://totp/Shop?secret=JBSWY3DPEHPK3PXP&digits=8" }),
    );
    assert!(
        matches!(refused, Err(CoreError::InvalidRequest { .. })),
        "a link asking for eight digits would make wrong codes: {refused:?}"
    );

    let answer = scratch.totp("item-otp");
    let bytes = answer.encode_to_vec();
    let code = answer.totp.expect("a code");
    let now = centraid_vault::time::recurrence::parse_instant_ms(NOW).expect("an instant");
    let expected = centraid_apps_locker::totp::code_at(
        "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
        now,
        crate::locker::phone::hmac_sha1_for_test,
    )
    .expect("the RFC seed makes a code");
    assert_eq!(code.code, expected.code);
    assert_eq!(code.code.len(), 6);
    assert_eq!(code.period_seconds, 30);
    // 02:00:00Z is the first second of a step.
    assert_eq!(code.remaining_seconds, 30);
    assert!(!code.receipt_id.is_empty(), "the code is receipted");
    let again = scratch.totp("item-otp").totp.expect("a code again");
    assert_eq!(again.code, code.code, "the same step, the same code");
    assert_ne!(
        again.receipt_id, code.receipt_id,
        "every code shown is its own receipt"
    );
    // THE SEED IS NEVER ANSWERED — not in a code, and not by a reveal.
    assert!(!contains(&bytes, "GEZDGNBV"));
    let asked = scratch.reveal("item-otp", "otp_seed");
    assert_eq!(
        asked.refusal,
        wire::LockerRevealRefusal::SeedNotShown as i32,
        "the seed is the second factor, and the phone only needs its code"
    );
    assert!(asked.revealed.is_none());
    assert!(!contains(&asked.encode_to_vec(), "GEZDGNBV"));

    assert_eq!(
        scratch.totp("item-plain").refusal,
        wire::LockerRevealRefusal::Empty as i32,
        "a login with no seed makes no code"
    );
    assert_eq!(
        scratch.totp("item-nobody").refusal,
        wire::LockerRevealRefusal::NotSealed as i32
    );
    scratch.relock();
    let locked = scratch.totp("item-otp");
    assert_eq!(locked.refusal, wire::LockerRevealRefusal::Locked as i32);
    assert!(locked.totp.is_none());
    // BEFORE THE SESSION AND BEFORE ANY RECEIPT: a locked session and an item
    // that does not exist answer the same refusal, so the ask never reached
    // the session (which a receipt needs) or the cell.
    assert_eq!(
        scratch.reveal("item-otp", "otp_seed").refusal,
        wire::LockerRevealRefusal::SeedNotShown as i32
    );
    assert_eq!(
        scratch.reveal("item-nobody", "otp_seed").refusal,
        wire::LockerRevealRefusal::SeedNotShown as i32
    );
}

// ---------------------------------------------------------------------------
// #1047 T2: custom sealed fields, passkeys, access history, import, export.
// ---------------------------------------------------------------------------

impl Scratch {
    fn step_reveal(&self, reveal: wire::LockerReveal) -> wire::LockerSessionResponse {
        self.session(Step::Reveal(reveal))
    }

    fn access(&self, item_id: &str) -> wire::LockerAccess {
        match self.ask(Q::LockerAccess(wire::LockerAccessRequest {
            item_id: item_id.to_owned(),
            limit: 0,
            tz: TZ.to_owned(),
        })) {
            Answer::LockerAccess(access) => access,
            other => panic!("access answered as {other:?}"),
        }
    }

    fn export(&self, format: wire::LockerExportFormat) -> wire::LockerSessionResponse {
        self.session(Step::Export(wire::LockerExportAsk {
            format: format as i32,
            tz: TZ.to_owned(),
        }))
    }

    fn import(&self, content: &str, publish: bool) -> wire::LockerSessionResponse {
        self.session(Step::ImportFile(wire::LockerImportAsk {
            content: content.as_bytes().to_vec(),
            publish,
        }))
    }

    /// The receipts this item's access history holds — the query's own
    /// answer, so a test counts what a member would see.
    fn receipts(&self, item_id: &str) -> usize {
        self.access(item_id).entries.len()
    }

    /// A passkey whose key material is real ciphertext under this vault's
    /// `K` — sealed here, because no phone door seals one (L-passkey).
    fn passkey(&self, item_id: &str) {
        let keys = crate::phone::Keyring::derive(&seed_of(WORDS), 0).expect("keys");
        let key_id = self
            .handle
            .with_vault(|vault| {
                vault
                    .locker_generation()
                    .map_err(|error| CoreError::Invariant {
                        context: error.to_string(),
                    })
            })
            .expect("a generation");
        let sealed = centraid_vault::custody::encrypt_under_locker_key(
            keys.vault.locker.as_bytes(),
            &key_id,
            item_id,
            "passkey-private-key-material",
        )
        .expect("it seals");
        self.run(
            "locker.set_passkey",
            json!({
                "item_id": item_id, "rp_id": "bank.example.com", "user_handle": "maya",
                "display_name": "Maya", "credential_id": "cred-1", "algorithm": "ES256",
                "private_key": sealed, "key_id": key_id
            }),
        );
    }
}

/// A CUSTOM SEALED FIELD IS SEALED BY THE CORE AGAINST ITS OWN ID, REVEALED
/// THROUGH THE ITEM'S DOOR, AND RECEIPTED AS THE FIELD — never as its label or
/// value (#1047 T2).
#[test]
fn a_custom_sealed_field_is_sealed_here_and_reveals_through_the_items_door() {
    let scratch = stocked();
    // Locked, a sealed field's value is refused before anything is written.
    let refused = scratch.try_run(
        "locker.set_field",
        json!({ "item_id": "item-bank", "field_id": "field-rc", "label": "Recovery code",
                "kind": "sealed", "value": "rc-4411" }),
    );
    assert!(refused.is_err(), "a locked Locker sealed a field");
    scratch.unlock();
    // A NEW SEALED FIELD NAMES ITS ID, because the ciphertext is bound to it.
    assert!(
        scratch
            .try_run(
                "locker.set_field",
                json!({ "item_id": "item-bank", "label": "Recovery code",
                        "kind": "sealed", "value": "rc-4411" }),
            )
            .is_err()
    );
    scratch.run(
        "locker.set_field",
        json!({ "item_id": "item-bank", "field_id": "field-rc", "section": "Recovery",
                "label": "Recovery code", "kind": "sealed", "value": "rc-4411" }),
    );
    let text = scratch.run(
        "locker.set_field",
        json!({ "item_id": "item-bank", "label": "Branch", "kind": "text", "value": "Leeds" }),
    );
    let stored = scratch
        .handle
        .with_vault(|vault| Ok(vault.locker_sealed_field_cell("item-bank", "field-rc")?))
        .expect("the cell reads")
        .and_then(|cell| cell.ciphertext)
        .expect("a ciphertext");
    assert!(stored.starts_with("lk1:") && !stored.contains("rc-4411"));

    let item = scratch.item("item-bank").expect("bank");
    let field = item
        .fields
        .iter()
        .find(|field| field.field_id == "field-rc")
        .expect("the field is listed");
    assert!(field.sealed && field.present && field.value.is_empty());
    assert!(!contains(
        &scratch.ask_bytes(Q::LockerItem(wire::LockerItemRequest {
            item_id: "item-bank".to_owned(),
            tz: TZ.to_owned(),
        })),
        "rc-4411"
    ));

    let revealed = scratch
        .step_reveal(wire::LockerReveal {
            item_id: "item-bank".to_owned(),
            column: "value_sealed".to_owned(),
            field_id: "field-rc".to_owned(),
            copy: true,
        })
        .revealed
        .expect("the field reveals");
    assert_eq!(revealed.value, "rc-4411");
    assert_eq!(revealed.field_id, "field-rc");
    // A plain field and another item's field reveal nothing.
    let text_id = text["field_id"].as_str().expect("an id").to_owned();
    for (item_id, field_id) in [("item-bank", text_id.as_str()), ("item-card", "field-rc")] {
        assert_eq!(
            scratch
                .step_reveal(wire::LockerReveal {
                    item_id: item_id.to_owned(),
                    column: "value_sealed".to_owned(),
                    field_id: field_id.to_owned(),
                    copy: false,
                })
                .refusal,
            wire::LockerRevealRefusal::NotSealed as i32
        );
    }
    // The placeholder keeps the value; removing the field removes it.
    scratch.run(
        "locker.set_field",
        json!({ "item_id": "item-bank", "field_id": "field-rc", "section": "Recovery",
                "label": "Recovery codes", "kind": "sealed", "value": "«sealed»" }),
    );
    let again = scratch
        .step_reveal(wire::LockerReveal {
            item_id: "item-bank".to_owned(),
            column: "value_sealed".to_owned(),
            field_id: "field-rc".to_owned(),
            copy: false,
        })
        .revealed
        .expect("kept");
    assert_eq!(again.value, "rc-4411");
    scratch.run(
        "locker.remove_field",
        json!({ "item_id": "item-bank", "field_id": "field-rc" }),
    );
    assert!(
        scratch
            .item("item-bank")
            .expect("bank")
            .fields
            .iter()
            .all(|field| field.field_id != "field-rc")
    );
}

/// A PASSKEY'S METADATA IS ON THE ITEM AND ITS KEY IS NEVER REVEALED — not
/// while locked, not while open, and with no receipt (#1047 T2, L-passkey).
#[test]
fn a_passkeys_metadata_reads_and_its_key_is_never_revealed() {
    let scratch = stocked();
    scratch.unlock();
    scratch.passkey("item-bank");
    let passkey = scratch
        .item("item-bank")
        .expect("bank")
        .passkey
        .expect("a passkey");
    assert_eq!(passkey.rp_id, "bank.example.com");
    assert_eq!(passkey.display_name, "Maya");
    assert_eq!(passkey.credential_id, "cred-1");
    assert_eq!(passkey.algorithm, "ES256");
    assert_eq!(passkey.created_local_day, "2099-06-30");
    assert!(passkey.has_private_key);

    let before = scratch.receipts("item-bank");
    let refused = scratch.reveal("item-bank", "private_key");
    assert_eq!(
        refused.refusal,
        wire::LockerRevealRefusal::KeyNotShown as i32
    );
    assert!(refused.revealed.is_none());
    scratch.relock();
    assert_eq!(
        scratch.reveal("item-bank", "private_key").refusal,
        wire::LockerRevealRefusal::KeyNotShown as i32,
        "refused before the session is consulted"
    );
    assert_eq!(
        scratch.receipts("item-bank"),
        before,
        "a refused key reveal wrote a receipt"
    );

    // RENAMED AND REMOVED: the placeholder keeps the key.
    scratch.run(
        "locker.set_passkey",
        json!({ "item_id": "item-bank", "rp_id": "bank.example.com", "user_handle": "maya",
                "display_name": "Maya at the bank", "credential_id": "cred-1",
                "algorithm": "ES256", "private_key": "«sealed»" }),
    );
    let renamed = scratch
        .item("item-bank")
        .expect("bank")
        .passkey
        .expect("kept");
    assert_eq!(renamed.display_name, "Maya at the bank");
    assert!(renamed.has_private_key);
    scratch.run("locker.clear_passkey", json!({ "item_id": "item-bank" }));
    assert!(scratch.item("item-bank").expect("bank").passkey.is_none());
}

/// ONE ITEM'S ACCESS HISTORY IS THE RECEIPTS ALREADY WRITTEN (#1047 T2):
/// reveals, copies and codes, newest first, metadata only, this item only.
#[test]
fn an_items_access_history_is_its_receipts_as_metadata() {
    let scratch = stocked();
    scratch.unlock();
    scratch.run(
        "locker.edit_item",
        json!({ "item_id": "item-bank", "username": "maya@example.com", "password": "«sealed»",
                "url": "https://bank.example.com", "otp_seed": "JBSWY3DPEHPK3PXP" }),
    );
    scratch.reveal("item-bank", "password");
    scratch.step_reveal(wire::LockerReveal {
        item_id: "item-bank".to_owned(),
        column: "password".to_owned(),
        copy: true,
        ..wire::LockerReveal::default()
    });
    scratch.session(Step::Totp(wire::LockerTotpAsk {
        item_id: "item-bank".to_owned(),
        copy: false,
    }));
    scratch.reveal("item-card", "card_number");

    let access = scratch.access("item-bank");
    assert_eq!(
        access.entries.len(),
        3,
        "the bank's three, not the card's or the unlock"
    );
    let kinds: Vec<(i32, bool)> = access
        .entries
        .iter()
        .map(|entry| (entry.kind, entry.copied))
        .collect();
    assert!(kinds.contains(&(wire::LockerAccessKind::Code as i32, false)));
    assert!(kinds.contains(&(wire::LockerAccessKind::Reveal as i32, true)));
    assert!(kinds.contains(&(wire::LockerAccessKind::Reveal as i32, false)));
    for entry in &access.entries {
        assert!(entry.allowed);
        assert_eq!(entry.local_day, "2099-06-30");
        assert_eq!(entry.local_time, "22:00");
    }
    assert!(!access.truncated);
    let bytes = scratch.ask_bytes(Q::LockerAccess(wire::LockerAccessRequest {
        item_id: "item-bank".to_owned(),
        limit: 0,
        tz: TZ.to_owned(),
    }));
    assert!(!contains(&bytes, PASSWORD), "a receipt carried the value");
}

/// EXPORT: the receipt first, then every live and archived secret in the
/// clear, in 1Password's CSV or Centraid's JSON — never a passkey's key and
/// never the trash; refused while locked (#1047 T2).
#[test]
fn an_export_is_receipted_first_and_carries_every_secret_but_a_passkeys_key() {
    let scratch = stocked();
    assert_eq!(
        scratch.export(wire::LockerExportFormat::Csv).refusal,
        wire::LockerRevealRefusal::Locked as i32
    );
    scratch.unlock();
    scratch.passkey("item-bank");
    scratch.run(
        "locker.set_field",
        json!({ "item_id": "item-bank", "field_id": "field-rc", "section": "Recovery",
                "label": "Recovery code", "kind": "sealed", "value": "rc-4411" }),
    );
    let csv = scratch
        .export(wire::LockerExportFormat::Csv)
        .exported
        .expect("a file");
    // THE ONE MASS-REVEAL RECEIPT, written before any cell opened.
    assert!(!csv.receipt_id.is_empty(), "the export was not receipted");
    assert_eq!(csv.file_name, "locker-2099-06-30.csv");
    assert_eq!(csv.media_type, "text/csv");
    assert_eq!(csv.item_count, 6, "live and archived, not the trash");
    assert_eq!(csv.unopened, 0);
    let text = String::from_utf8(csv.content).expect("utf-8");
    assert!(text.starts_with("Title,Url,Username,Password,OTPAuth"));
    assert!(text.contains(PASSWORD));
    assert!(text.contains("Card number: 4111111111111111"));
    assert!(text.contains("Recovery · Recovery code: rc-4411"));
    assert!(!text.contains("passkey-private-key-material"));
    assert!(!text.contains("Gone"), "the trash was exported");

    let json = scratch
        .export(wire::LockerExportFormat::Json)
        .exported
        .expect("a file");
    assert_eq!(json.file_name, "locker-2099-06-30.json");
    let text = String::from_utf8(json.content).expect("utf-8");
    assert!(text.contains("centraid-locker/1"));
    assert!(text.contains("rc-4411"));
    assert!(!text.contains("passkey-private-key-material"));
    assert!(!text.contains("lk1:"), "ciphertext rode the file");
}

/// IMPORT: a plan writes nothing; a publish seals every secret on the way in,
/// fills only empty fields, and the vault wins every collision (#1047 T2).
#[test]
fn an_import_plans_then_seals_in_and_the_vault_wins() {
    let scratch = stocked();
    let file = "name,url,username,password,note\n\
                Bank,https://bank.example.com/login,maya@example.com,not-the-vaults,x\n\
                Forum,http://forum.example.org,maya,forum-pw,\n\
                Shop,https://shop.example,maya,shop-pw,a note\n\
                Shop,https://shop.example/cart,maya,shop-pw-2,\n";
    assert_eq!(
        scratch.import(file, false).refusal,
        wire::LockerRevealRefusal::Locked as i32
    );
    scratch.unlock();
    assert_eq!(
        scratch
            .import("date,amount\n2026-01-01,1.00\n", false)
            .refusal,
        wire::LockerRevealRefusal::NotReadable as i32
    );
    let before = scratch.items(false).total;
    let plan = scratch.import(file, false).import_plan.expect("a plan");
    assert_eq!(plan.format, "csv");
    assert_eq!(
        (
            plan.new_count,
            plan.fill_count,
            plan.held_count,
            plan.skipped_count
        ),
        (1, 1, 1, 1)
    );
    assert!(!plan.published);
    assert_eq!(plan.rows[0].verdict, wire::LockerImportVerdict::Held as i32);
    assert_eq!(plan.rows[0].matched_item_id, "item-bank");
    assert_eq!(plan.rows[2].subtitle, "maya · shop.example");
    assert!(plan.rows[2].carries_secret);
    assert!(
        !contains(&plan.encode_to_vec(), "shop-pw"),
        "a plan carried a secret"
    );
    assert_eq!(scratch.items(false).total, before, "a plan wrote");

    let published = scratch.import(file, true).import_plan.expect("published");
    assert!(published.published);
    assert_eq!(
        (published.created, published.filled, published.failed),
        (1, 1, 0)
    );
    // THE VAULT WON: the bank's password is still the vault's.
    assert_eq!(
        scratch
            .reveal("item-bank", "password")
            .revealed
            .expect("bank")
            .value,
        PASSWORD
    );
    // THE FILL filled the forum's empty password and nothing else.
    assert_eq!(
        scratch
            .reveal("item-forum", "password")
            .revealed
            .expect("forum")
            .value,
        "forum-pw"
    );
    let forum = scratch.item("item-forum").expect("forum");
    assert_eq!(forum.url, "http://forum.example.org");
    assert_eq!(forum.username, "maya");
    // THE NEW ITEM's secret was sealed on the way in.
    let shop = scratch
        .search("shop")
        .items
        .into_iter()
        .next()
        .expect("the new item");
    assert_eq!(
        scratch
            .stored_password(&shop.item_id)
            .map(|stored| stored.starts_with("lk1:")),
        Some(true)
    );
    assert_eq!(
        scratch
            .reveal(&shop.item_id, "password")
            .revealed
            .expect("shop")
            .value,
        "shop-pw"
    );
}

/// CENTRAID'S OWN JSON COMES BACK WHOLE: fields, tags, star and memo.
#[test]
fn a_json_export_imports_back_whole() {
    let scratch = stocked();
    scratch.unlock();
    scratch.run(
        "locker.set_field",
        json!({ "item_id": "item-bank", "field_id": "field-rc", "section": "Recovery",
                "label": "Recovery code", "kind": "sealed", "value": "rc-4411" }),
    );
    scratch.run(
        "locker.set_memo",
        json!({ "item_id": "item-bank", "note": "the memo" }),
    );
    let exported = scratch
        .export(wire::LockerExportFormat::Json)
        .exported
        .expect("a file");
    let restored = Scratch::founded();
    restored.unlock();
    let published = restored
        .import(std::str::from_utf8(&exported.content).expect("utf-8"), true)
        .import_plan
        .expect("published");
    assert_eq!(published.format, "json");
    assert_eq!(published.created, 6);
    assert_eq!(published.failed, 0);
    let bank_id = restored
        .search("bank")
        .items
        .into_iter()
        .next()
        .expect("the bank")
        .item_id;
    let bank = restored.item(&bank_id).expect("the bank");
    assert!(bank.starred);
    assert_eq!(bank.tags, vec!["finance".to_owned()]);
    assert_eq!(bank.memo, "the memo");
    let field = bank
        .fields
        .iter()
        .find(|field| field.label == "Recovery code")
        .expect("the field came back");
    let value = restored
        .step_reveal(wire::LockerReveal {
            item_id: bank_id.clone(),
            column: "value_sealed".to_owned(),
            field_id: field.field_id.clone(),
            copy: false,
        })
        .revealed
        .expect("it reveals")
        .value;
    assert_eq!(value, "rc-4411");
    assert_eq!(
        restored.items(true).items.len(),
        1,
        "the archived item stays archived"
    );
}
