//! PHOTOS' ARM OF THE APP QUERY (#1097, R-1097-25..27): `photos.search`, the
//! text and album legs of Photos' own search, asked of the full-text door.
//!
//! **WHAT MOVED HERE.** Photos' search was Kotlin `LIKE` over
//! `media_asset.title`. Its text leg is now the photograph domain
//! (`core.content_item`: the caption, the text recognised in the picture and the
//! transcript of a video, in rank order) and its album leg is the album
//! container (`core.collection`, narrowed to the rows that open in Photos). The
//! shell keeps the STRUCTURED legs (the places, the labels) and folds them with
//! this answer.
//!
//! **THE PHOTOGRAPHS ARE LIVE ONES.** A hit is a content item; the app opens it
//! as the media assets that hold it, and a trashed or archived asset is no hit
//! (Photos' own shelf does not show one). Home's search keeps the archived ones
//! because it opens a photograph and does not draw a grid; the difference is
//! R-1097-25's and is held by `centraid_apps_photos::queries::load_search_term`.
//!
//! **THE CORRECTION IS THE SHELL'S TO ASK FOR.** The core cannot see the shell's
//! structured legs, and a typo is corrected only when EVERY leg is empty. So the
//! request carries `correct` only when the shell's legs found nothing for the
//! term as typed; the core corrects over the vocabularies of the photograph
//! domain and the album container, runs its legs at the corrected words and
//! answers them with the words. The core does NOT drop a correction its own legs
//! found nothing at, because the shell's legs may find something at those words
//! (a mistyped place's name finds no caption); the shell keeps the correction
//! only if the whole answer is not empty. Places and labels are not corrected:
//! the vault holds no vocabulary of them in the index (a place is arithmetic on
//! a coordinate and a gazetteer name inside a JSON column, a label a concept the
//! shell reads through the page door).

use centraid_api_proto::core_v1 as wire;
use centraid_apps_kit::Denial;
use centraid_apps_kit::error::KitResult;
use centraid_apps_photos as photos;
use centraid_apps_photos::queries::PHOTO_TARGET_TYPE;
use centraid_search::{Principal, Search};
use centraid_vault::Vault;

use super::{RecordingSearch, VaultDoor, named, settle};
use crate::error::{CoreError, Result};

type Answer = wire::app_query_response::Answer;

/// The app a Photos album opens in.
const APP: &str = "photos";

/// What the core's legs answer for one term.
type Found = (photos::queries::SearchData, Vec<centraid_search::Target>);

pub(super) fn search(
    vault: &Vault,
    door: &VaultDoor<'_>,
    asked: &wire::PhotosSearchRequest,
) -> Result<Answer> {
    if asked.limit == 0 {
        // REQUIRED AND VALIDATED, not defaulted: proto3 cannot say "required".
        return Err(CoreError::InvalidRequest {
            detail: "a photos search carries no limit; a default is how an unbounded read \
                     gets written by accident"
                .to_owned(),
        });
    }
    let limit = usize::try_from(asked.limit).unwrap_or(usize::MAX);
    let loaded = vault.read(|connection| {
        let index = match centraid_search::SqliteDoor::open(connection) {
            Ok(index) => index,
            Err(error) => {
                return Ok(Err(CoreError::Invariant {
                    context: format!("the search index will not open: {error}"),
                }));
            }
        };
        let search = RecordingSearch {
            inner: &index,
            door,
        };
        Ok(Ok(answer(door, &search, &asked.term, limit, asked.correct)))
    })??;
    settle(door, loaded, |((data, albums), corrected)| {
        Answer::PhotosSearch(wire::PhotosSearch {
            asset_ids: data.asset_ids,
            albums: albums.into_iter().map(named::to_wire).collect(),
            corrected,
        })
    })
}

/// The exact term; and, when the shell allows it and the core's legs found
/// nothing and nothing was denied, the corrected words.
fn answer(
    door: &VaultDoor<'_>,
    search: &dyn Search,
    term: &str,
    limit: usize,
    may_correct: bool,
) -> KitResult<((Found, String), Option<Denial>)> {
    let (exact, denial) = run(door, search, term, limit)?;
    if denial.is_some() || !may_correct || !is_empty(&exact) || term.trim().is_empty() {
        return Ok(((exact, String::new()), denial));
    }
    let entities = [PHOTO_TARGET_TYPE, "core.collection"];
    // A failure of the door's `correct` is the recorder's to keep; here it only
    // means there is no correction.
    let Ok(Some(words)) = search.correct(&Principal::Owner, &entities, term) else {
        return Ok(((exact, String::new()), None));
    };
    let (again, denial) = run(door, search, &words, limit)?;
    if denial.is_some() {
        return Ok(((exact, String::new()), denial));
    }
    Ok(((again, words), None))
}

fn is_empty((data, albums): &Found) -> bool {
    data.asset_ids.is_empty() && albums.is_empty()
}

/// Both legs at one term: the photographs, then the albums. A denial answers for
/// the whole search.
fn run(
    door: &VaultDoor<'_>,
    search: &dyn Search,
    term: &str,
    limit: usize,
) -> KitResult<(Found, Option<Denial>)> {
    let (data, denial) =
        photos::queries::load_search_term(door, search, &Principal::Owner, term, limit)?;
    if denial.is_some() {
        return Ok(((data, Vec::new()), denial));
    }
    let (albums, denial) = named::of_app(search, APP, term, limit.min(named::CONTAINER_ROWS));
    Ok(((data, albums), denial))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::CoreConfig;
    use crate::handle::{Core, Handle};
    use wire::app_query_request::Query as Q;
    use wire::app_query_response::Answer as A;

    const NOW: &str = "2099-06-02T02:00:00.000Z";
    /// Four one-pixel PNGs of different colours: the same bytes are the same
    /// content item (two photographs of one picture share a sha), so a test that
    /// wants distinct photographs wants distinct bytes.
    const PIXELS: [&str; 4] = [
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4IScHAAK2AQU0pnWqAAAAAElFTkSuQmCC",
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQOyEHAAIMAQUtuDZBAAAAAElFTkSuQmCC",
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQkzsBAAFiAQURG6MhAAAAAElFTkSuQmCC",
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4cUIOAAQKAa9ALaa4AAAAAElFTkSuQmCC",
    ];

    struct Scratch {
        dir: std::path::PathBuf,
        handle: Handle,
        writes: std::cell::Cell<u32>,
        photos: std::cell::Cell<usize>,
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
            handle
                .open_own_bytes(dir.join("vault.bytes"))
                .expect("the byte store opens");
            Self {
                dir,
                handle,
                writes: std::cell::Cell::new(0),
                photos: std::cell::Cell::new(0),
            }
        }

        fn ask(&self, query: Q) -> A {
            let response = self
                .handle
                .call(&wire::Request {
                    kind: Some(wire::request::Kind::AppQuery(wire::AppQueryRequest {
                        query: Some(query),
                    })),
                })
                .expect("the query answers");
            match response.kind {
                Some(wire::response::Kind::AppQuery(answer)) => answer.answer.expect("an answer"),
                other => panic!("an app query answered as {other:?}"),
            }
        }

        fn search_with(&self, term: &str, limit: u32, correct: bool) -> wire::PhotosSearch {
            match self.ask(Q::PhotosSearch(wire::PhotosSearchRequest {
                term: term.to_owned(),
                limit,
                correct,
            })) {
                A::PhotosSearch(found) => found,
                other => panic!("photos.search answered as {other:?}"),
            }
        }

        fn search(&self, term: &str) -> wire::PhotosSearch {
            self.search_with(term, 50, false)
        }

        fn home(&self, term: &str) -> wire::VaultSearch {
            match self.ask(Q::VaultSearch(wire::VaultSearchRequest {
                term: term.to_owned(),
                tz: "America/New_York".to_owned(),
            })) {
                A::VaultSearch(found) => found,
                other => panic!("vault.search answered as {other:?}"),
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
                        invoke_key: format!("photos-search-test-{}", self.writes.get()),
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

        /// A photograph with a caption; its asset id and its content id.
        fn photo(&self, title: &str) -> (String, String) {
            let pixel = PIXELS[self.photos.get()];
            self.photos.set(self.photos.get() + 1);
            let added = self.run(
                "media.add_asset",
                serde_json::json!({
                    "data_uri": format!("data:image/png;base64,{pixel}"),
                    "kind": "photo",
                    "title": title,
                }),
            );
            (
                added["asset_id"].as_str().expect("an asset id").to_owned(),
                added["content_id"]
                    .as_str()
                    .expect("a content id")
                    .to_owned(),
            )
        }

        /// The text a recogniser read in the picture, or a video's transcript:
        /// a derivative of the content item, which the index folds in. No
        /// command writes one yet (the enrichment plane's), so it is planted
        /// the way a sync pass writes a row.
        fn derive(&self, content_id: &str, variant: &str, text: &str) {
            self.handle
                .with_vault(|vault| {
                    Ok(vault.apply_replica(|connection| {
                        centraid_apps_kit::fixtures::plant_text_derivative(
                            connection, content_id, variant, text, NOW,
                        )
                        .expect("the derivative is planted");
                        Ok(())
                    })?)
                })
                .expect("the derivative is written");
        }
    }

    /// THE WORDS IN THE PICTURE ARE SEARCHABLE (R-1097-25): a word only the
    /// recognised text or the transcript holds finds its photograph, and one
    /// only the caption holds still does. Members gain OCR and transcript hits
    /// in Photos.
    #[test]
    fn an_ocr_or_transcript_word_finds_its_photograph() {
        let scratch = Scratch::founded();
        let (captioned, _) = scratch.photo("Harbour at dusk");
        let (receipt, receipt_content) = scratch.photo("Untitled");
        let (clip, clip_content) = scratch.photo("Birthday clip");
        scratch.derive(&receipt_content, "text", "Invoice number 4411 Lantern Cafe");
        scratch.derive(
            &clip_content,
            "transcript",
            "happy birthday dear grandmother",
        );

        assert_eq!(scratch.search("dusk").asset_ids, vec![captioned]);
        assert_eq!(scratch.search("lantern").asset_ids, vec![receipt.clone()]);
        assert_eq!(scratch.search("grandmother").asset_ids, vec![clip]);
        // THE WORDS OF ONE QUERY ARE ALL REQUIRED, as on Home.
        assert_eq!(scratch.search("lantern cafe").asset_ids, vec![receipt]);
        assert!(scratch.search("lantern grandmother").asset_ids.is_empty());
        // Nothing to correct: the shell did not ask, and the term is exact.
        assert!(scratch.search("lantern").corrected.is_empty());
    }

    /// PHOTOS' SHELF IS THE LIVE ONE (R-1097-25): a trashed photograph and an
    /// archived one are not found, and an archived one comes back when it is
    /// restored. HOME KEEPS THE ARCHIVED ONE: it opens a photograph and draws
    /// no grid, so the two rules differ on purpose.
    #[test]
    fn an_archived_or_trashed_photograph_is_not_found_in_photos_and_an_archived_one_is_on_home() {
        let scratch = Scratch::founded();
        let (asset, _) = scratch.photo("Heron at the weir");
        assert_eq!(scratch.search("heron").asset_ids, vec![asset.clone()]);

        scratch.run(
            "media.update_asset",
            serde_json::json!({ "asset_id": asset, "archived": 1 }),
        );
        assert!(
            scratch.search("heron").asset_ids.is_empty(),
            "an archived photograph is not on Photos' shelf"
        );
        assert!(
            scratch
                .home("heron")
                .hits
                .iter()
                .any(|hit| hit.app_id == "photos" && hit.open_id == asset),
            "Home still finds an archived photograph and opens it"
        );

        scratch.run(
            "media.update_asset",
            serde_json::json!({ "asset_id": asset, "archived": 0 }),
        );
        assert_eq!(scratch.search("heron").asset_ids, vec![asset.clone()]);

        scratch.run(
            "media.delete_asset",
            serde_json::json!({ "asset_id": asset }),
        );
        assert!(scratch.search("heron").asset_ids.is_empty());
        assert!(
            scratch
                .home("heron")
                .hits
                .iter()
                .all(|hit| hit.app_id != "photos"),
            "a trashed photograph is no hit anywhere"
        );
    }

    /// A TYPO IS CORRECTED ONLY WHEN THE SHELL SAYS ITS OWN LEGS FOUND NOTHING,
    /// and only when the core's are empty too (R-1097-27): the exact term is
    /// searched first and never corrected when it finds something.
    #[test]
    fn a_typo_is_corrected_only_when_every_leg_is_empty_and_the_shell_asks() {
        let scratch = Scratch::founded();
        let (asset, _) = scratch.photo("Sunscreen on the shelf");

        // Not asked: the term as typed, no correction.
        let plain = scratch.search_with("sunscren", 50, false);
        assert!(plain.asset_ids.is_empty() && plain.corrected.is_empty());

        // Asked: the corrected words and what they find.
        let fixed = scratch.search_with("sunscren", 50, true);
        assert_eq!(fixed.corrected, "sunscreen");
        assert_eq!(fixed.asset_ids, vec![asset.clone()]);

        // An exact term is never corrected, asked or not.
        let exact = scratch.search_with("sunscreen", 50, true);
        assert!(exact.corrected.is_empty());
        assert_eq!(exact.asset_ids, vec![asset]);

        // A word nothing is near is not corrected into one.
        let none = scratch.search_with("zzqxvbn", 50, true);
        assert!(none.corrected.is_empty() && none.asset_ids.is_empty());
    }

    /// A PERSON'S NAME IS NOT PART OF THE VOCABULARY: Photos searches no
    /// people any more (the face surfaces left, Q-1047-2), so a mistyped name is
    /// not corrected to words nothing in Photos could find.
    #[test]
    fn a_mistyped_name_is_not_corrected_over_the_parties() {
        let scratch = Scratch::founded();
        scratch.run(
            "people.add_person",
            serde_json::json!({ "display_name": "Marguerite", "cadence_days": 30 }),
        );
        let fixed = scratch.search_with("margerite", 50, true);
        assert!(fixed.corrected.is_empty());
        assert!(fixed.asset_ids.is_empty() && fixed.albums.is_empty());
    }

    /// ALBUMS ARE THE DOOR'S, NARROWED TO PHOTOS (R-1097-25): a notebook of the
    /// same name is Notes' and is not an album here; an album that was deleted
    /// is gone; a typo in the name is corrected.
    #[test]
    fn albums_are_the_core_collections_that_open_in_photos() {
        let scratch = Scratch::founded();
        let album = scratch.run(
            "media.create_album",
            serde_json::json!({ "title": "Heron trip" }),
        )["album_id"]
            .as_str()
            .expect("an album id")
            .to_owned();
        scratch.run(
            "knowledge.create_notebook",
            serde_json::json!({ "name": "Heron notes" }),
        );

        let found = scratch.search("heron");
        assert_eq!(found.albums.len(), 1, "{:?}", found.albums);
        let hit = &found.albums[0];
        assert_eq!(
            (hit.id.as_str(), hit.title.as_str()),
            (album.as_str(), "Heron trip")
        );
        assert_eq!(hit.entity, "core.collection");
        assert_eq!(hit.app_id, "photos");

        // A slip in the album's name is corrected, and the album is the answer.
        let fixed = scratch.search_with("heorn", 50, true);
        assert_eq!(fixed.corrected, "heron");
        assert_eq!(fixed.albums.len(), 1);

        scratch.run(
            "media.delete_album",
            serde_json::json!({ "album_id": album }),
        );
        assert!(scratch.search("heron").albums.is_empty());
    }

    /// A SEARCH WITHOUT A LIMIT IS REFUSED (the window is required), and a blank
    /// term answers nothing rather than every photograph.
    #[test]
    fn a_limit_is_required_and_a_blank_term_answers_nothing() {
        let scratch = Scratch::founded();
        scratch.photo("Anything at all");
        let refused = scratch.handle.call(&wire::Request {
            kind: Some(wire::request::Kind::AppQuery(wire::AppQueryRequest {
                query: Some(Q::PhotosSearch(wire::PhotosSearchRequest {
                    term: "anything".to_owned(),
                    limit: 0,
                    correct: false,
                })),
            })),
        });
        assert!(refused.is_err(), "a zero limit is a refusal");
        let blank = scratch.search("   ");
        assert!(blank.asset_ids.is_empty() && blank.albums.is_empty());
    }
}
