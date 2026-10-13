//! HOME'S ARM OF THE APP QUERY (R-CHROME-6): `vault.search`, every app's
//! search domain but Locker's, for Home's search bar.
//!
//! **NOT A SECOND SEARCH.** The rows are Notes' powerbox's
//! ([`queries::load_link_targets`]): one isolated probe per
//! `centraid_search::DOMAINS` domain, the owner as principal, People's journal
//! notes left out, Locker never a domain (D-1020-N1). This module opens the FTS
//! door, runs that loader and converts — plus the one thing a hit needs to be
//! OPENED rather than linked: a photo is a content item in the index and a
//! media asset in Photos, so its asset is read here, by content id, and a
//! photo whose asset is gone or trashed is dropped; a person is a `core.party`
//! in the index and a live `people_profile` in People, so a party with no live
//! profile (a Tally friend, a trashed person) is dropped too.
//!
//! **A TYPO IS CORRECTED ACROSS THE SEVEN DOMAINS** (#1097, R4, R8), only when
//! the whole answer is empty, and the answer says so in `corrected`.

use std::collections::{BTreeMap, BTreeSet};

use centraid_api_proto::core_v1 as wire;
use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{FanOutBound, PageDoor, in_list, read_pages};
use centraid_apps_kit::row::text_of;
use centraid_apps_kit::statement::{PageOrder, PageQuery};
use centraid_apps_notes::queries;
use centraid_search::{Principal, Target};
use centraid_vault::Vault;

use super::notes::subtitle_day;
use super::{VaultDoor, corrected_search, settle, zone_if_any};
use crate::error::{CoreError, Result};

type Answer = wire::app_query_response::Answer;

/// The entity a photo is in the index (`centraid_search::DOMAINS`).
const PHOTO_ENTITY: &str = "core.content_item";

/// The party entity a person is in the index (`centraid_search::DOMAINS`).
const PARTY_ENTITY: &str = "core.party";

/// The rows one answer can open: the loader's eight per domain, with room.
const OPENABLE: FanOutBound = FanOutBound::new(64, 1);

/// What a Home answer is made of: the hits that open something, and the media
/// asset each photo opens by.
type Opened = (Vec<Target>, BTreeMap<String, String>);

pub(super) fn search(
    vault: &Vault,
    door: &VaultDoor<'_>,
    asked: &wire::VaultSearchRequest,
) -> Result<Answer> {
    // ISOLATED PER DOMAIN, as the powerbox is (`notes::link_targets`): the
    // plain FTS door, so one domain's refusal drops its rows and not the answer.
    //
    // THE CORRECTION SPANS THE SEVEN DOMAINS (#1097, R4, R8) and runs only when
    // the whole answer, after the rows that cannot be opened are dropped, is
    // empty; the vocabulary it reads is every domain's.
    let loaded = vault.read(|connection| {
        let index =
            centraid_search::SqliteDoor::open(connection).map_err(|error| CoreError::Invariant {
                context: format!("the search index will not open: {error}"),
            });
        let entities: Vec<&str> = centraid_search::DOMAINS
            .iter()
            .map(|domain| domain.entity)
            .collect();
        Ok(index.map(|index| {
            corrected_search(
                &index,
                &entities,
                &asked.term,
                |(targets, _): &Opened| targets.is_empty(),
                |term| {
                    let (data, denial) =
                        queries::load_link_targets(door, &index, &Principal::Owner, term)?;
                    if denial.is_some() {
                        return Ok(((Vec::new(), BTreeMap::new()), denial));
                    }
                    let assets = photo_assets(door, &data.targets)?;
                    let people = live_people(door, &data.targets)?;
                    let targets = data
                        .targets
                        .into_iter()
                        .filter(|target| match target.entity.as_str() {
                            PHOTO_ENTITY => assets.contains_key(&target.id),
                            PARTY_ENTITY => people.contains(&target.id),
                            _ => true,
                        })
                        .collect();
                    Ok(((targets, assets), None))
                },
            )
        }))
    })??;
    let zone = zone_if_any(vault, &asked.tz)?;
    settle(door, loaded, |((targets, assets), corrected)| {
        Answer::VaultSearch(wire::VaultSearch {
            corrected,
            hits: targets
                .into_iter()
                .map(|target| {
                    let open_id = if target.entity == PHOTO_ENTITY {
                        assets.get(&target.id).cloned().unwrap_or_default()
                    } else {
                        String::new()
                    };
                    wire::VaultSearchHit {
                        subtitle_local_day: subtitle_day(zone.as_ref(), &target.subtitle),
                        entity: target.entity,
                        id: target.id,
                        title: target.title,
                        subtitle: target.subtitle,
                        app_id: target.app_id,
                        snippet: target.snippet,
                        open_id,
                    }
                })
                .collect(),
        })
    })
}

/// Each photo hit's LIVE media asset, by content id. Empty when no hit is a
/// photo — an `IN ()` is a read nobody needed.
fn photo_assets(door: &dyn PageDoor, targets: &[Target]) -> KitResult<BTreeMap<String, String>> {
    let content_ids: Vec<String> = targets
        .iter()
        .filter(|target| target.entity == PHOTO_ENTITY)
        .map(|target| target.id.clone())
        .collect();
    if content_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let fragment = in_list("content_id", &content_ids)?;
    let rows = read_pages(
        door,
        &PageQuery::new(
            "vault.search.photo_assets",
            "asset_id, content_id",
            "media_asset",
            PageOrder::asc("asset_id", "asset_id"),
        )
        .filter(
            &format!("{} AND deleted_at IS NULL", fragment.sql),
            fragment.bind,
        ),
        OPENABLE,
    )?;
    Ok(rows
        .iter()
        .filter_map(|row| Some((text_of(row, "content_id")?, text_of(row, "asset_id")?)))
        .collect())
}

/// The party hits that have a LIVE People profile: the ones People can show.
///
/// `core.party` is every party in the vault — a Tally friend, a trashed person
/// — and only a live `people_profile` makes one a person in People, whose own
/// search drops the rest (`people_profile.deleted_at IS NULL`). A Home row opens
/// People at that person, so one that cannot be shown is not a hit.
fn live_people(door: &dyn PageDoor, targets: &[Target]) -> KitResult<BTreeSet<String>> {
    let party_ids: Vec<String> = targets
        .iter()
        .filter(|target| target.entity == PARTY_ENTITY)
        .map(|target| target.id.clone())
        .collect();
    if party_ids.is_empty() {
        return Ok(BTreeSet::new());
    }
    let fragment = in_list("party_id", &party_ids)?;
    let rows = read_pages(
        door,
        &PageQuery::new(
            "vault.search.live_people",
            "party_id",
            "people_profile",
            PageOrder::asc("party_id", "party_id"),
        )
        .filter(
            &format!("{} AND deleted_at IS NULL", fragment.sql),
            fragment.bind,
        ),
        OPENABLE,
    )?;
    Ok(rows
        .iter()
        .filter_map(|row| text_of(row, "party_id"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::CoreConfig;
    use crate::handle::{Core, Handle};
    use wire::app_query_request::Query as Q;

    const NOW: &str = "2099-06-02T02:00:00.000Z";
    const TZ: &str = "America/New_York";

    struct Scratch {
        dir: std::path::PathBuf,
        handle: Handle,
        writes: std::cell::Cell<u32>,
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    impl Scratch {
        fn founded() -> Self {
            let dir = centraid_ontology::golden::scratch_dir();
            std::fs::create_dir_all(&dir).expect("the directory is made");
            let now = centraid_vault::time::recurrence::parse_instant_ms(NOW).expect("an instant");
            let handle = Core::open(CoreConfig::new(dir.join("vault.db")).with_clock(
                std::sync::Arc::new(centraid_vault::clock::FixedClock::at(now)),
                std::sync::Arc::new(centraid_vault::clock::ClockIds::new(Box::new(
                    centraid_vault::clock::FixedClock::at(now),
                ))),
            ))
            .expect("it opens");
            handle
                .with_vault(|vault| Ok(vault.found("Home", "Owner")?))
                .expect("it founds");
            Self {
                dir,
                handle,
                writes: std::cell::Cell::new(0),
            }
        }

        fn search(&self, term: &str) -> wire::VaultSearch {
            let response = self
                .handle
                .call(&wire::Request {
                    kind: Some(wire::request::Kind::AppQuery(wire::AppQueryRequest {
                        query: Some(Q::VaultSearch(wire::VaultSearchRequest {
                            term: term.to_owned(),
                            tz: TZ.to_owned(),
                        })),
                    })),
                })
                .expect("vault.search answers");
            match response.kind {
                Some(wire::response::Kind::AppQuery(answer)) => match answer.answer {
                    Some(Answer::VaultSearch(found)) => found,
                    other => panic!("vault.search answered as {other:?}"),
                },
                other => panic!("an app query answered as {other:?}"),
            }
        }

        fn run(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
            self.writes.set(self.writes.get() + 1);
            let response = self
                .handle
                .call(&wire::Request {
                    kind: Some(wire::request::Kind::Command(wire::Command {
                        name: name.to_owned(),
                        input: serde_json::to_vec(&input).expect("json"),
                        invoke_key: format!("vault-search-test-{}", self.writes.get()),
                        ..wire::Command::default()
                    })),
                })
                .unwrap_or_else(|error| panic!("{name} refused: {error}"));
            let Some(wire::response::Kind::Command(outcome)) = response.kind else {
                panic!("a command answered with something else");
            };
            assert_eq!(
                outcome.status,
                wire::CommandStatus::Executed as i32,
                "{name}: {}",
                outcome.reason
            );
            serde_json::from_slice(&outcome.output).expect("the output is JSON")
        }
    }

    /// ONE TERM, EVERY APP THAT HOLDS IT: a note and a task that share a word
    /// both answer, each naming the app it opens in; a blank term answers
    /// nothing rather than every row; and Locker is never asked — it is not a
    /// domain, so no hit can name it.
    #[test]
    fn one_term_answers_every_app_but_locker() {
        let scratch = Scratch::founded();
        let note = scratch.run(
            "knowledge.create_note",
            serde_json::json!({ "title": "Cabin packing", "body_text": "bring the lantern" }),
        )["note_id"]
            .as_str()
            .expect("a note id")
            .to_owned();
        let task = scratch.run(
            "schedule.add_task",
            serde_json::json!({ "title": "Book the cabin" }),
        )["task_id"]
            .as_str()
            .expect("a task id")
            .to_owned();
        let found = scratch.search("cabin");
        let hits: Vec<(&str, &str, &str)> = found
            .hits
            .iter()
            .map(|hit| (hit.app_id.as_str(), hit.entity.as_str(), hit.id.as_str()))
            .collect();
        assert!(
            hits.contains(&("notes", "knowledge.note", note.as_str())),
            "{hits:?}"
        );
        assert!(
            hits.contains(&("tasks", "schedule.task", task.as_str())),
            "{hits:?}"
        );
        assert!(
            centraid_search::DOMAINS
                .iter()
                .all(|domain| domain.app_id != "locker")
                && found.hits.iter().all(|hit| hit.app_id != "locker"),
            "Locker is never searched: {hits:?}"
        );
        assert!(
            found.hits.iter().all(|hit| hit.open_id.is_empty()),
            "only a photo opens by another id"
        );
        assert!(
            scratch.search("   ").hits.is_empty(),
            "a blank term reads nothing"
        );
    }

    /// THE CORRECTION SPANS THE SEVEN DOMAINS (#1097, R4, R8): a slip in a word
    /// two apps hold finds both, once, and says what it searched; an exact term
    /// is untouched.
    #[test]
    fn a_typo_is_corrected_across_every_domain_and_an_exact_term_is_not() {
        let scratch = Scratch::founded();
        scratch.run(
            "knowledge.create_note",
            serde_json::json!({ "title": "Cabin packing", "body_text": "bring the lantern" }),
        );
        scratch.run(
            "schedule.add_task",
            serde_json::json!({ "title": "Book the cabin" }),
        );
        let slipped = scratch.search("cabni");
        let apps: Vec<&str> = slipped.hits.iter().map(|hit| hit.app_id.as_str()).collect();
        assert!(
            apps.contains(&"notes") && apps.contains(&"tasks"),
            "{apps:?}"
        );
        assert_eq!(slipped.corrected, "cabin");
        let exact = scratch.search("cabin");
        assert_eq!(exact.hits.len(), slipped.hits.len());
        assert!(exact.corrected.is_empty());
        let nothing = scratch.search("zeppelin");
        assert!(nothing.hits.is_empty() && nothing.corrected.is_empty());
    }

    /// A HOME ROW OPENS A PERSON PEOPLE CAN SHOW (#1097): a `core.party` with no
    /// live People profile — a Tally friend, a trashed person — is in the index
    /// and is not a hit.
    #[test]
    fn a_party_with_no_live_profile_is_no_home_hit() {
        let scratch = Scratch::founded();
        let person = scratch.run(
            "people.add_person",
            serde_json::json!({ "display_name": "Zelda Person", "cadence_days": 30 }),
        )["party_id"]
            .as_str()
            .expect("a party id")
            .to_owned();
        let gone = scratch.run(
            "people.add_person",
            serde_json::json!({ "display_name": "Zelda Trashed", "cadence_days": 30 }),
        )["party_id"]
            .as_str()
            .expect("a party id")
            .to_owned();
        scratch.run(
            "people.trash_person",
            serde_json::json!({ "party_id": gone }),
        );
        let friend = scratch.run(
            "tally.add_friend",
            serde_json::json!({ "name": "Zelda Friend" }),
        )["party_id"]
            .as_str()
            .expect("a party id")
            .to_owned();
        let parties = |term: &str| -> Vec<String> {
            scratch
                .search(term)
                .hits
                .into_iter()
                .filter(|hit| hit.entity == "core.party")
                .map(|hit| hit.id)
                .collect()
        };
        assert_eq!(parties("zelda"), std::slice::from_ref(&person));
        assert!(!parties("zelda").contains(&gone) && !parties("zelda").contains(&friend));
        // The answer is judged after the drop: a term only a Tally friend holds
        // is an empty answer, and it is corrected like any other.
        assert!(parties("zelda friend").is_empty());
        let slipped = scratch.search("zleda");
        assert_eq!(slipped.corrected, "zelda");
        assert_eq!(
            slipped
                .hits
                .iter()
                .filter(|hit| hit.entity == "core.party")
                .map(|hit| hit.id.clone())
                .collect::<Vec<_>>(),
            [person]
        );
    }

    /// A PHOTO OPENS AS ITS ASSET: the index answers its content item, and the
    /// hit carries the media asset Photos opens by; once that asset is in the
    /// trash the photo is no hit at all.
    #[test]
    fn a_photo_hit_carries_its_asset_and_a_trashed_one_is_gone() {
        const ONE_PIXEL_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        let scratch = Scratch::founded();
        scratch
            .handle
            .open_own_bytes(scratch.dir.join("vault.bytes"))
            .expect("the byte store opens");
        let asset = scratch.run(
            "media.add_asset",
            serde_json::json!({
                "data_uri": format!("data:image/png;base64,{ONE_PIXEL_PNG}"),
                "kind": "photo",
                "title": "Cabin at dusk",
            }),
        )["asset_id"]
            .as_str()
            .expect("an asset id")
            .to_owned();
        let found = scratch.search("dusk");
        let photo = found
            .hits
            .iter()
            .find(|hit| hit.app_id == "photos")
            .expect("the photo is a hit");
        assert_eq!(photo.entity, PHOTO_ENTITY);
        assert_eq!(photo.open_id, asset);
        assert_ne!(photo.id, asset, "the hit's id is the content item's");
        scratch.run(
            "media.delete_asset",
            serde_json::json!({ "asset_id": asset }),
        );
        assert!(
            scratch
                .search("dusk")
                .hits
                .iter()
                .all(|hit| hit.app_id != "photos"),
            "a trashed photo is no hit"
        );
    }
}
