//! WHAT EACH APP'S BACKUP HOLDS ([#1144](https://github.com/srikanth235/centraid/issues/1144)):
//! the rows behind the Backup screen's "In this backup", and the byte totals
//! its line says.
//!
//! **Counts come from each app's visible rows** (`centraid_vault::backup::holdings`),
//! even when several rows or apps refer to the same original. Byte ownership is
//! separate: the original and its derivatives contribute bytes only once;
//! which kinds are an app's is said here, once, against the catalogue's roster,
//! so a tenth app with no kinds named reads as holding nothing rather than as
//! a gap ([`kinds_of`]).
//!
//! **A size is the app's own files plus its share of the rest.** Photos owns
//! each photograph's original and every derivative made from it, and Docs each
//! document's; everything else — the vault file a snapshot copies, and the
//! files no one app owns (an avatar, a revision's bytes, a chat's image) — is
//! shared by record rows, with the remainder of the division going to the
//! apps with the most rows, so the rows add up to the total to the byte.
//!
//! **"Backed up" here is the line's**: a file counts once a gateway holds its
//! bytes and a snapshot it acknowledged holds its row ([`super::Outcome`]); the
//! shared bytes count once any snapshot was acknowledged, because the vault
//! file travels whole in every one. A row written since that snapshot is an
//! edit that waits for the next.

use std::collections::BTreeMap;

use centraid_api_proto::core_v1 as wire;
use centraid_vault::Vault;
use centraid_vault::backup::files::ContentFile;
use centraid_vault::backup::holdings::{FileOwner, Holdings, holdings};
use centraid_vault::backup::state::DeviceState;

use super::{Outcome, plane_error, records_backed_up_at};
use crate::catalog::APPS;
use crate::error::Result;

/// What `backup_status` adds to its answer.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Held {
    pub apps: Vec<wire::AppHolding>,
    pub total_bytes: u64,
    pub confirmed_bytes: u64,
    pub left_out_items: u64,
    pub left_out_bytes: u64,
    /// Per gateway, per app: originals it has not acknowledged whole (#1188, NB1).
    pub behind: BTreeMap<String, BTreeMap<&'static str, u64>>,
}

/// The entity kinds an app's rows are, and the ones it counts as its items.
/// Health's items are days with a reading, and it counts its workouts apart.
#[must_use]
pub(crate) fn kinds_of(app: &str) -> (&'static [&'static str], &'static [&'static str]) {
    match app {
        "calendar" => (&["event", "calendar"], &["event"]),
        "docs" => (&["document", "folder"], &["document"]),
        "health" => (&["activity", "activity_kind", "workout_kind"], &[]),
        "locker" => (&["locker_item"], &["locker_item"]),
        "money" => (&["account", "txn", "category"], &["txn"]),
        "notes" => (&["note", "notebook"], &["note"]),
        "people" => (&["person", "relation"], &["person"]),
        "photos" => (&["photo", "album", "place"], &["photo"]),
        "reminders" => (&["task", "list", "project", "section", "area"], &["task"]),
        _ => (&[], &[]),
    }
}

/// The app that owns a file, by the kind of row that does.
const fn owner_app(owner: FileOwner) -> &'static str {
    match owner {
        FileOwner::Photo => "photos",
        FileOwner::Document => "docs",
    }
}

/// Read the vault's holdings and fold them with where each file stands.
/// `outcomes` is [`super::standing`]'s, in the order of `files`.
///
/// # Errors
/// The ledger's refusal, or a vault that will not read.
pub(crate) fn read(
    vault: &Vault,
    state: &DeviceState,
    files: &[ContentFile],
    outcomes: &[Outcome],
    lagging: &[Vec<String>],
) -> Result<Held> {
    let records_at = records_backed_up_at(state)?;
    let since = records_at
        .and_then(|at| i64::try_from(at).ok())
        .map(centraid_vault::clock::format_iso_ms);
    let holdings = holdings(vault, since.as_deref()).map_err(plane_error)?;
    let mut held = fold(&holdings, files, outcomes, records_at.is_some());
    // WHAT EACH GATEWAY STILL OWES, BY APP: only an owned original names an app.
    for (file, behind) in files.iter().zip(lagging) {
        if behind.is_empty() || !file.is_original() {
            continue;
        }
        if let Some(owner) = holdings.owners.get(&file.h) {
            for id in behind {
                *held
                    .behind
                    .entry(id.clone())
                    .or_default()
                    .entry(owner_app(*owner))
                    .or_default() += 1;
            }
        }
    }
    Ok(held)
}

/// One app's files, as they stand.
#[derive(Debug, Default, Clone, Copy)]
struct Files {
    /// Bytes counted toward the backup, and of those the confirmed.
    bytes: u64,
    bytes_confirmed: u64,
    left_out_items: u64,
    left_out_bytes: u64,
}

impl Files {
    fn add(&mut self, file: &ContentFile, outcome: Outcome) {
        let original = file.is_original();
        match outcome {
            Outcome::LeftOut => {
                self.left_out_bytes = self.left_out_bytes.saturating_add(file.len);
                if original {
                    self.left_out_items += 1;
                }
                return;
            }
            Outcome::Confirmed => {
                self.bytes_confirmed = self.bytes_confirmed.saturating_add(file.len);
            }
            Outcome::Waiting => {}
        }
        self.bytes = self.bytes.saturating_add(file.len);
    }
}

/// Visible item rows follow the actual original's coverage, not its byte owner.
#[derive(Debug, Default, Clone, Copy)]
struct Items {
    total: u64,
    confirmed: u64,
    waiting: u64,
    left_out: u64,
}

/// The pure fold: every app in the catalogue's order, its files and its share.
pub(crate) fn fold(
    holdings: &Holdings,
    files: &[ContentFile],
    outcomes: &[Outcome],
    records_acked: bool,
) -> Held {
    // EACH FILE TO ITS OWNER, or to the shared pool.
    let mut owned: BTreeMap<&str, Files> = BTreeMap::new();
    let mut unowned = Files::default();
    for (file, outcome) in files.iter().zip(outcomes) {
        match holdings.owners.get(&file.h) {
            Some(owner) => owned
                .entry(owner_app(*owner))
                .or_default()
                .add(file, *outcome),
            None => unowned.add(file, *outcome),
        }
    }
    let coverage: BTreeMap<_, _> = files
        .iter()
        .zip(outcomes)
        .map(|(file, outcome)| (file.h, *outcome))
        .collect();
    let mut visible: BTreeMap<&str, Items> = BTreeMap::new();
    for (owner, originals) in &holdings.original_items {
        let items = visible.entry(owner_app(*owner)).or_default();
        for (hash, count) in originals {
            items.total = items.total.saturating_add(*count);
            match coverage.get(hash).copied().unwrap_or(Outcome::Waiting) {
                Outcome::Confirmed => items.confirmed = items.confirmed.saturating_add(*count),
                Outcome::Waiting => items.waiting = items.waiting.saturating_add(*count),
                Outcome::LeftOut => items.left_out = items.left_out.saturating_add(*count),
            }
        }
    }
    let rows = |kinds: &[&str], map: &BTreeMap<String, u64>| -> u64 {
        kinds
            .iter()
            .map(|kind| map.get(*kind).copied().unwrap_or(0))
            .sum()
    };
    // THE SHARED POOL, BY RECORD ROWS: what each app keeps in the vault file.
    let weights: Vec<u64> = APPS
        .iter()
        .map(|app| {
            let (kinds, _) = kinds_of(app.id);
            let extra = if app.id == "health" {
                holdings.readings
            } else {
                0
            };
            rows(kinds, &holdings.live) + extra
        })
        .collect();
    let pool = holdings.file_bytes.saturating_add(unowned.bytes);
    let pool_confirmed = if records_acked {
        holdings.file_bytes
    } else {
        0
    }
    .saturating_add(unowned.bytes_confirmed);
    let shares = share(pool, &weights);
    let shares_confirmed = share(pool_confirmed, &weights);
    let mut held = Held {
        left_out_items: unowned.left_out_items,
        left_out_bytes: unowned.left_out_bytes,
        ..Held::default()
    };
    for (at, app) in APPS.iter().enumerate() {
        let (kinds, counted) = kinds_of(app.id);
        let mine = owned.get(app.id).copied().unwrap_or_default();
        let bytes = mine.bytes.saturating_add(shares[at]);
        let bytes_confirmed = mine.bytes_confirmed.saturating_add(shares_confirmed[at]);
        // Every visible row counts, including an excluded video. Byte attribution
        // still keeps shared originals, derivatives and retained trash only once.
        let visible = visible.get(app.id).copied().unwrap_or_default();
        let (items, items_confirmed) = if matches!(app.id, "photos" | "docs") {
            (visible.total, visible.confirmed)
        } else if app.id == "people" {
            (holdings.visible_people, 0)
        } else if app.id == "health" {
            (holdings.reading_days, 0)
        } else {
            (rows(counted, &holdings.live), 0)
        };
        held.total_bytes = held.total_bytes.saturating_add(bytes);
        held.confirmed_bytes = held.confirmed_bytes.saturating_add(bytes_confirmed);
        held.left_out_items += mine.left_out_items;
        held.left_out_bytes = held.left_out_bytes.saturating_add(mine.left_out_bytes);
        held.apps.push(wire::AppHolding {
            app_id: app.id.to_owned(),
            items,
            workouts: if app.id == "health" {
                holdings.workouts
            } else {
                0
            },
            items_confirmed,
            bytes,
            bytes_confirmed,
            waiting: visible.waiting,
            edits_waiting: rows(kinds, &holdings.edited),
            left_out_items: visible.left_out,
            left_out_bytes: mine.left_out_bytes,
        });
    }
    held
}

/// `total` shared by `weights`, every part rounded down and the bytes left
/// over handed one at a time to the heaviest weights first, so the parts add
/// up to `total`. All weights zero shares evenly.
#[must_use]
pub(crate) fn share(total: u64, weights: &[u64]) -> Vec<u64> {
    if weights.is_empty() {
        return Vec::new();
    }
    let sum: u128 = weights.iter().map(|weight| u128::from(*weight)).sum();
    let even = sum == 0;
    let weight = |at: usize| if even { 1 } else { u128::from(weights[at]) };
    let sum = if even {
        u128::try_from(weights.len()).unwrap_or(1)
    } else {
        sum
    };
    let mut parts: Vec<u64> = (0..weights.len())
        .map(|at| u64::try_from(u128::from(total) * weight(at) / sum).unwrap_or(u64::MAX))
        .collect();
    let mut left = total.saturating_sub(parts.iter().sum());
    let mut order: Vec<usize> = (0..weights.len()).collect();
    order.sort_by(|a, b| weight(*b).cmp(&weight(*a)).then(a.cmp(b)));
    for at in order.iter().cycle() {
        if left == 0 {
            break;
        }
        parts[*at] += 1;
        left -= 1;
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_vault::backup::naming::PlaintextHash;

    fn file(seed: u8, len: u64, variant: Option<&str>, video: bool) -> ContentFile {
        ContentFile {
            h: PlaintextHash::from_bytes([seed; 32]),
            len,
            media_type: if video { "video/mp4" } else { "image/jpeg" }.to_owned(),
            variant: variant.map(str::to_owned),
            video,
            created_at: String::new(),
        }
    }

    fn app<'a>(held: &'a Held, id: &str) -> &'a wire::AppHolding {
        held.apps
            .iter()
            .find(|row| row.app_id == id)
            .expect("every catalogue app has a row")
    }

    #[test]
    fn shares_add_up_to_the_total_and_follow_the_weights() {
        assert_eq!(share(10, &[1, 1, 1]), vec![4, 3, 3]);
        assert_eq!(share(100, &[3, 1, 0]), vec![75, 25, 0]);
        assert_eq!(share(7, &[0, 0]), vec![4, 3]);
        assert_eq!(share(0, &[5, 5]), vec![0, 0]);
        assert!(share(5, &[]).is_empty());
    }

    #[test]
    fn every_catalogue_app_names_its_kinds() {
        for app in APPS {
            assert!(
                !kinds_of(app.id).0.is_empty(),
                "`{}` has no kinds: its rows would read as holding nothing",
                app.id
            );
        }
    }

    #[test]
    fn files_go_to_their_owner_and_the_rest_is_shared_by_rows() {
        let photo = file(1, 1_000, None, false);
        let thumb = file(2, 100, Some("thumb"), false);
        let video = file(3, 5_000, None, true);
        let document = file(4, 400, None, false);
        let avatar = file(5, 50, None, false);
        let files = vec![
            photo.clone(),
            thumb.clone(),
            video.clone(),
            document.clone(),
            avatar,
        ];
        let outcomes = [
            Outcome::Confirmed,
            Outcome::Confirmed,
            Outcome::LeftOut,
            Outcome::Waiting,
            Outcome::Confirmed,
        ];
        let holdings = Holdings {
            live: BTreeMap::from([
                ("note".to_owned(), 3),
                ("photo".to_owned(), 2),
                ("document".to_owned(), 1),
            ]),
            edited: BTreeMap::from([("note".to_owned(), 2)]),
            visible_people: 0,
            workouts: 4,
            reading_days: 9,
            readings: 0,
            owners: BTreeMap::from([
                (photo.h, FileOwner::Photo),
                (thumb.h, FileOwner::Photo),
                (video.h, FileOwner::Photo),
                (document.h, FileOwner::Document),
            ]),
            original_items: BTreeMap::from([
                (
                    FileOwner::Photo,
                    BTreeMap::from([(photo.h, 1), (video.h, 1)]),
                ),
                (FileOwner::Document, BTreeMap::from([(document.h, 1)])),
            ]),
            file_bytes: 550,
        };
        let held = fold(&holdings, &files, &outcomes, true);
        // The excluded video remains a visible item, but adds no backed-up bytes.
        assert_eq!((held.left_out_items, held.left_out_bytes), (1, 5_000));
        let photos = app(&held, "photos");
        assert_eq!(
            (photos.items, photos.items_confirmed, photos.waiting),
            (2, 1, 0)
        );
        assert_eq!((photos.left_out_items, photos.left_out_bytes), (1, 5_000));
        // The pool is the vault file and the avatar, 600 bytes over 6 rows.
        assert_eq!(photos.bytes, 1_100 + 200);
        let docs = app(&held, "docs");
        assert_eq!((docs.items, docs.items_confirmed, docs.waiting), (1, 0, 1));
        assert_eq!((docs.bytes, docs.bytes_confirmed), (400 + 100, 100));
        let notes = app(&held, "notes");
        assert_eq!((notes.items, notes.bytes, notes.edits_waiting), (3, 300, 2));
        let health = app(&held, "health");
        assert_eq!((health.items, health.workouts), (9, 4));
        // THE ROWS ADD UP TO THE TOTALS, to the byte.
        let sum: u64 = held.apps.iter().map(|row| row.bytes).sum();
        assert_eq!(held.total_bytes, sum);
        assert_eq!(held.total_bytes, 1_100 + 400 + 600);
        assert_eq!(held.confirmed_bytes, 1_100 + 600);
    }

    #[test]
    fn shared_original_coverage_counts_every_visible_reference_but_bytes_stay_unique() {
        let video = file(7, 300_000, None, true);
        let holdings = Holdings {
            live: BTreeMap::from([("photo".to_owned(), 1), ("document".to_owned(), 2)]),
            owners: BTreeMap::from([(video.h, FileOwner::Document)]),
            original_items: BTreeMap::from([
                (FileOwner::Photo, BTreeMap::from([(video.h, 1)])),
                (FileOwner::Document, BTreeMap::from([(video.h, 2)])),
            ]),
            file_bytes: 900,
            ..Holdings::default()
        };
        for outcome in [Outcome::Waiting, Outcome::Confirmed, Outcome::LeftOut] {
            let held = fold(&holdings, std::slice::from_ref(&video), &[outcome], true);
            let photos = app(&held, "photos");
            let docs = app(&held, "docs");
            assert_eq!((photos.items, docs.items), (1, 2));
            assert_eq!(
                photos.items_confirmed,
                u64::from(outcome == Outcome::Confirmed)
            );
            assert_eq!(
                docs.items_confirmed,
                2 * u64::from(outcome == Outcome::Confirmed)
            );
            assert_eq!(photos.waiting, u64::from(outcome == Outcome::Waiting));
            assert_eq!(docs.waiting, 2 * u64::from(outcome == Outcome::Waiting));
            assert_eq!(
                photos.left_out_items,
                u64::from(outcome == Outcome::LeftOut)
            );
            assert_eq!(
                docs.left_out_items,
                2 * u64::from(outcome == Outcome::LeftOut)
            );
            assert_eq!(photos.left_out_bytes, 0, "byte attribution stays with Docs");
            assert_eq!(held.left_out_items, u64::from(outcome == Outcome::LeftOut));
            assert_eq!(
                held.left_out_bytes,
                300_000 * u64::from(outcome == Outcome::LeftOut)
            );
            assert_eq!(
                held.total_bytes,
                if outcome == Outcome::LeftOut {
                    900
                } else {
                    300_900
                }
            );
            assert_eq!(
                held.apps.iter().map(|row| row.bytes).sum::<u64>(),
                held.total_bytes
            );

            // Changing visible multiplicity does not move or duplicate any byte allocation.
            let mut one_each = holdings.clone();
            one_each
                .original_items
                .get_mut(&FileOwner::Document)
                .expect("Docs refs")
                .insert(video.h, 1);
            let same_bytes = fold(&one_each, std::slice::from_ref(&video), &[outcome], true);
            assert_eq!(same_bytes.total_bytes, held.total_bytes);
            assert_eq!(same_bytes.confirmed_bytes, held.confirmed_bytes);
            assert_eq!(
                same_bytes
                    .apps
                    .iter()
                    .map(|row| (row.bytes, row.bytes_confirmed, row.left_out_bytes))
                    .collect::<Vec<_>>(),
                held.apps
                    .iter()
                    .map(|row| (row.bytes, row.bytes_confirmed, row.left_out_bytes))
                    .collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn visible_people_changes_only_item_counts_not_raw_record_byte_attribution() {
        let mut holdings = Holdings {
            live: BTreeMap::from([("person".to_owned(), 4), ("note".to_owned(), 2)]),
            edited: BTreeMap::from([("person".to_owned(), 2)]),
            file_bytes: 600,
            ..Default::default()
        };
        let before = fold(&holdings, &[], &[], true);
        for visible in [0, 1, 2] {
            holdings.visible_people = visible;
            let after = fold(&holdings, &[], &[], true);
            assert_eq!(app(&after, "people").items, visible);
            assert_eq!(app(&after, "people").edits_waiting, 2);
            assert_eq!(after.total_bytes, before.total_bytes);
            assert_eq!(after.confirmed_bytes, before.confirmed_bytes);
            assert_eq!(after.left_out_bytes, before.left_out_bytes);
            assert_eq!(
                after
                    .apps
                    .iter()
                    .map(|a| (a.bytes, a.bytes_confirmed, a.left_out_bytes))
                    .collect::<Vec<_>>(),
                before
                    .apps
                    .iter()
                    .map(|a| (a.bytes, a.bytes_confirmed, a.left_out_bytes))
                    .collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn nothing_shared_is_backed_up_before_a_snapshot_was_acknowledged() {
        let holdings = Holdings {
            live: BTreeMap::from([("note".to_owned(), 1)]),
            file_bytes: 4_096,
            ..Holdings::default()
        };
        let held = fold(&holdings, &[], &[], false);
        assert_eq!((held.total_bytes, held.confirmed_bytes), (4_096, 0));
        assert_eq!(app(&held, "notes").bytes, 4_096);
    }
}
