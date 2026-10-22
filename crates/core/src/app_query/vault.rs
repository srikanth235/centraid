//! HOME'S ARM OF THE APP QUERY: `vault.search`, every app's kinds but Locker's,
//! for Home's search bar.
//!
//! **ONE QUESTION PER KEYSTROKE.** The rows are the kinds Notes' powerbox can
//! link ([`queries::load_link_targets`] asks them one probe each, a sheet of six
//! columns) and the NAMED kinds beside them, a notebook or an album, a project, a
//! Docs folder, and a chat thread (entity `thread`, app `chat`, found by its
//! title and by what the member said). Home asks the door ONCE
//! ([`queries::load_targets_each`], `Search::query_each`) for at most eight
//! rows of each kind: eleven statements per keystroke were seconds on a vault of
//! years, and one is milliseconds. The owner is the principal, People's journal
//! notes are left out, Locker is not a kind the index holds.
//!
//! The linkable rows come first and the containers after them, each with the app
//! it opens in; every one opens by its `id`. A shell with no Chat tab draws no
//! `chat` row. A photo opens by its own id (the index holds live photographs
//! only, so none is trashed); a person is in People's circle only when live and
//! neither the owner nor a pet, so those are dropped.
//!
//! **A typo is corrected across all of those kinds**, only when the whole answer,
//! rows and containers, is empty, and the answer says so in `corrected`.

use std::collections::BTreeSet;

use centraid_api_proto::core_v1 as wire;
use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_notes::queries;
use centraid_search::{Principal, Target};
use centraid_vault::Vault;

use super::notes::subtitle_day;
use super::{VaultDoor, corrected_search, named, settle, zone_if_any};
use crate::error::{CoreError, Result};

type Answer = wire::app_query_response::Answer;

/// The entity a photo is in the index (`centraid_search::DOMAINS`).
const PHOTO_ENTITY: &str = "photo";

/// The kind a person is in the index.
const PERSON_ENTITY: &str = "person";

/// What a Home answer is made of: the hits that open something and the
/// containers that matched.
type Opened = (Vec<Target>, Vec<Target>);

pub(super) fn search(
    vault: &Vault,
    door: &VaultDoor<'_>,
    asked: &wire::VaultSearchRequest,
) -> Result<Answer> {
    // THE CORRECTION SPANS THE LINKABLE AND THE NAMED KINDS and runs only when
    // the whole answer, after the rows that cannot be opened are dropped, is
    // empty; the vocabulary it reads is the one index's.
    let loaded = vault.read(|connection| {
        let index = centraid_search::SqliteDoor::open(connection, vault.words()).map_err(|error| {
            CoreError::Invariant {
                context: format!("the search index will not open: {error}"),
            }
        });
        let entities: Vec<&str> = centraid_vault::index::SEARCHABLE
            .iter()
            .filter(|kind| **kind != centraid_vault::model::Kind::LockerItem)
            .map(|kind| kind.as_str())
            .collect();
        Ok(index.map(|index| {
            corrected_search(
                &index,
                &entities,
                &asked.term,
                |(targets, found): &Opened| targets.len() + found.len(),
                |(exact, exact_found), (again, again_found)| {
                    (
                        filled_each_kind(exact, again, &linkable_kinds()),
                        filled_each_kind(exact_found, again_found, named::all()),
                    )
                },
                |term| {
                    // ONE STATEMENT for the six domains and the named kinds.
                    let (all, denial) = queries::load_targets_each(
                        door,
                        &index,
                        &Principal::Owner,
                        term,
                        named::all(),
                    )?;
                    if denial.is_some() {
                        return Ok(((Vec::new(), Vec::new()), denial));
                    }
                    let (found, rows): (Vec<Target>, Vec<Target>) = all
                        .into_iter()
                        .partition(|target| named::is_named(&target.entity));
                    let people = live_people(door, &rows)?;
                    let targets = rows
                        .into_iter()
                        .filter(|target| {
                            target.entity != PERSON_ENTITY || people.contains(&target.id)
                        })
                        .collect();
                    Ok(((targets, found), None))
                },
            )
        }))
    })??;
    let zone = zone_if_any(vault, &asked.tz)?;
    settle(door, loaded, |((targets, found), corrected)| {
        Answer::VaultSearch(wire::VaultSearch {
            corrected,
            hits: targets
                .into_iter()
                .map(|target| {
                    // A photograph opens by its own id.
                    let open_id = if target.entity == PHOTO_ENTITY {
                        target.id.clone()
                    } else {
                        String::new()
                    };
                    wire::VaultSearchHit {
                        app_id: named::app_of(&target.entity).to_owned(),
                        subtitle_local_day: subtitle_day(zone.as_ref(), &target.subtitle),
                        entity: target.entity,
                        id: target.id,
                        title: target.title,
                        subtitle: target.subtitle,
                        snippet: target.snippet,
                        open_id,
                    }
                })
                .chain(found.into_iter().map(|container| wire::VaultSearchHit {
                    app_id: named::app_of(&container.entity).to_owned(),
                    subtitle_local_day: subtitle_day(zone.as_ref(), &container.subtitle),
                    entity: container.entity,
                    id: container.id,
                    title: container.title,
                    subtitle: container.subtitle,
                    snippet: container.snippet,
                    open_id: String::new(),
                }))
                .collect(),
        })
    })
}

/// The hits of `exact`, then those of `extra` that are not among them, at most
/// [`queries::LINK_TARGET_ROWS`] of each kind: Home's window is per kind.
/// The kinds' order is kept: a kind that gained a row is still where its kind was.
fn filled_each_kind(exact: Vec<Target>, extra: Vec<Target>, kinds: &[&str]) -> Vec<Target> {
    let mut per_kind: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for target in &exact {
        *per_kind.entry(target.entity.clone()).or_default() += 1;
    }
    let mut seen: BTreeSet<(String, String)> = exact
        .iter()
        .map(|target| (target.entity.clone(), target.id.clone()))
        .collect();
    let mut hits = exact;
    for target in extra {
        let held = per_kind.entry(target.entity.clone()).or_default();
        if *held < queries::LINK_TARGET_ROWS
            && seen.insert((target.entity.clone(), target.id.clone()))
        {
            *held += 1;
            hits.push(target);
        }
    }
    hits.sort_by_key(|target| kinds.iter().position(|kind| *kind == target.entity));
    hits
}

/// The kinds Home lists as rows, in the order it lists them.
fn linkable_kinds() -> Vec<&'static str> {
    centraid_vault::commands::note::LINKABLE
        .iter()
        .map(|kind| kind.as_str())
        .collect()
}

/// The person hits People can show: the live circle. The index holds the owner
/// and a pet too, and a Home row opens People at that person, so one that cannot
/// be shown is not a hit.
fn live_people(door: &dyn PageDoor, targets: &[Target]) -> KitResult<BTreeSet<String>> {
    let person_ids: Vec<String> = targets
        .iter()
        .filter(|target| target.entity == PERSON_ENTITY)
        .map(|target| target.id.clone())
        .collect();
    if person_ids.is_empty() {
        return Ok(BTreeSet::new());
    }
    centraid_apps_people::queries::circle_among(door, &person_ids)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

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
            let dir = centraid_ontology::scratch::scratch_dir();
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
            "note.create",
            serde_json::json!({ "title": "Cabin packing", "body": "bring the lantern" }),
        )["id"]
            .as_str()
            .expect("a note id")
            .to_owned();
        let task = scratch.run("task.add", serde_json::json!({ "title": "Book the cabin" }))["id"]
            .as_str()
            .expect("a task id")
            .to_owned();
        let found = scratch.search("cabin");
        let hits: Vec<(&str, &str, &str)> = found
            .hits
            .iter()
            .map(|hit| (hit.app_id.as_str(), hit.entity.as_str(), hit.id.as_str()))
            .collect();
        assert!(hits.contains(&("notes", "note", note.as_str())), "{hits:?}");
        assert!(hits.contains(&("tasks", "task", task.as_str())), "{hits:?}");
        assert!(
            found.hits.iter().all(|hit| hit.app_id != "locker"),
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

    /// THE CORRECTION SPANS THE SIX DOMAINS AND THE NAMED KINDS (#1097, R4, R8): a slip in a word
    /// two apps hold finds both, once, and says what it searched; an exact term
    /// is untouched.
    #[test]
    fn a_typo_is_corrected_across_every_domain_and_an_exact_term_is_not() {
        let scratch = Scratch::founded();
        scratch.run(
            "note.create",
            serde_json::json!({ "title": "Cabin packing", "body": "bring the lantern" }),
        );
        scratch.run("task.add", serde_json::json!({ "title": "Book the cabin" }));
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

    /// A HOME ROW OPENS A PERSON PEOPLE CAN SHOW (#1097): a pet is in the index
    /// and is not a hit, and a trashed person leaves the index.
    #[test]
    fn a_pet_and_a_trashed_person_are_no_home_hit() {
        let scratch = Scratch::founded();
        let add = |title: &str, form: &str| -> String {
            scratch.run(
                "person.add",
                serde_json::json!({ "title": title, "form": form }),
            )["id"]
                .as_str()
                .expect("an id")
                .to_owned()
        };
        let person = add("Zelda Person", "person");
        let gone = add("Zelda Trashed", "person");
        scratch.run("entity.trash", serde_json::json!({ "id": gone }));
        let pet = add("Zelda Pet", "pet");
        let people = |term: &str| -> Vec<String> {
            scratch
                .search(term)
                .hits
                .into_iter()
                .filter(|hit| hit.entity == "person")
                .map(|hit| hit.id)
                .collect()
        };
        assert_eq!(people("zelda"), std::slice::from_ref(&person));
        assert!(!people("zelda").contains(&gone) && !people("zelda").contains(&pet));
        // The answer is judged after the drop: a term only a pet holds is an
        // empty answer, and it is corrected like any other.
        assert!(people("zelda pet").is_empty());
        let slipped = scratch.search("zleda");
        assert_eq!(slipped.corrected, "zelda");
        assert_eq!(
            slipped
                .hits
                .iter()
                .filter(|hit| hit.entity == "person")
                .map(|hit| hit.id.clone())
                .collect::<Vec<_>>(),
            [person]
        );
    }

    /// A NOTE LOGGED ON AN INTERACTION FINDS ITS PERSON FROM HOME (#1097,
    /// Q-1097-5): "lunch at Rao's" is the person's memo, so the person is a Home
    /// hit, opening in People; an unrelated person is not, and a slip in the
    /// note's word is corrected to it.
    #[test]
    fn an_interaction_note_finds_its_person_on_home() {
        let scratch = Scratch::founded();
        let add = |title: &str| -> String {
            scratch.run(
                "person.add",
                serde_json::json!({ "title": title, "cadence_days": 30 }),
            )["id"]
                .as_str()
                .expect("an id")
                .to_owned()
        };
        let ravi = add("Ravi Menon");
        let other = add("Jake Bennett");
        scratch.run(
            "person.log_interaction",
            serde_json::json!({ "id": ravi, "kind": "lunch", "text": "lunch at Rao's" }),
        );
        let parties = |found: wire::VaultSearch| -> Vec<(String, String)> {
            found
                .hits
                .into_iter()
                .filter(|hit| hit.entity == "person")
                .map(|hit| (hit.app_id, hit.id))
                .collect()
        };
        assert_eq!(
            parties(scratch.search("lunch")),
            [("people".to_owned(), ravi.clone())]
        );
        assert!(
            !parties(scratch.search("rao"))
                .iter()
                .any(|(_, id)| *id == other)
        );
        let slipped = scratch.search("lnuch");
        assert_eq!(slipped.corrected, "lunch");
        assert_eq!(parties(slipped), [("people".to_owned(), ravi)]);
    }

    /// A PHOTO OPENS BY ITS OWN ID, and once it is in the trash the photo is no
    /// hit at all.
    #[test]
    fn a_photo_hit_opens_by_its_id_and_a_trashed_one_is_gone() {
        const ONE_PIXEL_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        let scratch = Scratch::founded();
        scratch
            .handle
            .open_own_bytes(scratch.dir.join("vault.bytes"))
            .expect("the byte store opens");
        let png = {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD
                .decode(ONE_PIXEL_PNG)
                .expect("a PNG")
        };
        let blob =
            centraid_vault::bytes::BlobStore::put(&scratch.handle.bytes().expect("a door"), &png)
                .expect("the store takes it");
        let photo = scratch.run(
            "photo.add",
            serde_json::json!({
                "blob": blob, "size": png.len(), "media_type": "image/png",
                "title": "Cabin at dusk",
            }),
        )["id"]
            .as_str()
            .expect("a photo id")
            .to_owned();
        let found = scratch.search("dusk");
        let hit = found
            .hits
            .iter()
            .find(|hit| hit.app_id == "photos")
            .expect("the photo is a hit");
        assert_eq!(hit.entity, PHOTO_ENTITY);
        assert_eq!(
            (hit.id.as_str(), hit.open_id.as_str()),
            (photo.as_str(), photo.as_str())
        );
        scratch.run("entity.trash", serde_json::json!({ "id": photo }));
        assert!(
            scratch
                .search("dusk")
                .hits
                .iter()
                .all(|hit| hit.app_id != "photos"),
            "a trashed photo is no hit"
        );
    }

    /// EVERY CONTAINER IS A HOME HIT (#1097, R-1097-19..21), each with the app it
    /// opens in: a notebook (Notes), an album (Photos), a project (Tasks) and a
    /// Docs folder.
    #[test]
    fn every_container_is_a_home_hit_with_its_app_and_open_id() {
        let scratch = Scratch::founded();
        let id = |output: serde_json::Value, key: &str| -> String {
            output[key].as_str().expect("an id").to_owned()
        };
        let notebook = id(
            scratch.run(
                "container.create",
                serde_json::json!({ "kind": "notebook", "title": "Heron notes" }),
            ),
            "id",
        );
        let album = id(
            scratch.run(
                "container.create",
                serde_json::json!({ "kind": "album", "title": "Heron trip" }),
            ),
            "id",
        );
        let project = id(
            scratch.run(
                "container.create",
                serde_json::json!({ "kind": "project", "title": "Heron hide" }),
            ),
            "id",
        );
        let folder = id(
            scratch.run(
                "container.create",
                serde_json::json!({ "kind": "folder", "title": "Heron papers" }),
            ),
            "id",
        );
        let found = scratch.search("heron");
        let hits: BTreeMap<(&str, &str), (&str, &str)> = found
            .hits
            .iter()
            .map(|hit| {
                (
                    (hit.app_id.as_str(), hit.entity.as_str()),
                    (hit.id.as_str(), hit.open_id.as_str()),
                )
            })
            .collect();
        assert_eq!(hits.len(), 4, "{hits:?}");
        assert_eq!(hits[&("notes", "notebook")], (notebook.as_str(), ""));
        assert_eq!(hits[&("photos", "album")], (album.as_str(), ""));
        assert_eq!(hits[&("tasks", "project")], (project.as_str(), ""));
        assert_eq!(hits[&("docs", "folder")], (folder.as_str(), ""));
        // Titles are the names; a container's subtitle is its kind.
        let titled: BTreeSet<&str> = found.hits.iter().map(|hit| hit.title.as_str()).collect();
        assert!(titled.contains("Heron notes") && titled.contains("Heron hide"));
        assert!(found.hits.iter().all(|hit| hit.subtitle == hit.entity));
        assert!(found.corrected.is_empty());
    }

    /// A CONTAINER THAT IS GONE IS NOT FOUND: a deleted notebook, a deleted album,
    /// a deleted folder.
    #[test]
    fn a_deleted_container_is_no_home_hit() {
        let scratch = Scratch::founded();
        let id = |output: serde_json::Value, key: &str| -> String {
            output[key].as_str().expect("an id").to_owned()
        };
        let notebook = id(
            scratch.run(
                "container.create",
                serde_json::json!({ "kind": "notebook", "title": "Ibis notes" }),
            ),
            "id",
        );
        let album = id(
            scratch.run(
                "container.create",
                serde_json::json!({ "kind": "album", "title": "Ibis trip" }),
            ),
            "id",
        );
        let folder = id(
            scratch.run(
                "container.create",
                serde_json::json!({ "kind": "folder", "title": "Ibis papers" }),
            ),
            "id",
        );
        assert_eq!(scratch.search("ibis").hits.len(), 3);
        scratch.run("entity.trash", serde_json::json!({ "id": notebook }));
        scratch.run("entity.trash", serde_json::json!({ "id": album }));
        scratch.run("entity.trash", serde_json::json!({ "id": folder }));
        assert!(scratch.search("ibis").hits.is_empty());
        assert!(
            scratch.search("ibsi").corrected.is_empty(),
            "nothing is left to correct to"
        );
    }

    /// A TYPO IN A CONTAINER'S NAME IS CORRECTED, and Home says what it
    /// searched: the correction reads the container indexes' vocabularies too,
    /// and runs only because notes, tasks and the rest held nothing.
    #[test]
    fn a_typo_in_a_container_name_is_corrected_on_home() {
        let scratch = Scratch::founded();
        scratch.run(
            "container.create",
            serde_json::json!({ "kind": "notebook", "title": "Marmoset recipes" }),
        );
        let slipped = scratch.search("marmsoet");
        assert_eq!(slipped.corrected, "marmoset");
        assert_eq!(slipped.hits.len(), 1);
        assert_eq!(slipped.hits[0].app_id, "notes");
        // An exact term is untouched; and once a NOTE holds the exact word the
        // containers do not make the answer "empty" either.
        let exact = scratch.search("marmoset");
        assert!(exact.corrected.is_empty() && exact.hits.len() == 1);
    }
}
