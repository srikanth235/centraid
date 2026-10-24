//! COLLECTIONS, the band's second destination and the hub of the rest of Photos
//! (v0's "The rest of Photos is in Collections"). One core read, `photos.albums`,
//! answers every album with its exact count and cover, the albums in the trash,
//! the standing shelves with their exact counts, and the doors' numbers, so the
//! screen makes no count of its own and a count is never a floor.
//!
//! Four sections, each foldable, with the rows sorted the way the system sorts
//! them: Pinned holds what a member reaches for (Favorites, Videos, and Places in
//! the slot the system gives its Map); Albums the member's own; Utilities the
//! housekeeping (Duplicates, Archive, Trash); Recently deleted the albums in the
//! trash, each with its Restore. A tap on a card is the route in the card.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::photos_collection_card::Kind;

use super::super::cells::{self, Link};
use super::super::routes;
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::read::{self, Reading};
use crate::screen::Ctx;
use crate::strings::{Locale, fill, photos as words, photos_home as sentences};

pub const PINNED: &str = "pinned";
pub const ALBUMS: &str = "albums";
pub const UTILITIES: &str = "utilities";
pub const DELETED: &str = "deleted";
const SECTIONS: [&str; 4] = [PINNED, ALBUMS, UTILITIES, DELETED];

#[derive(Debug, Default)]
pub struct Collections {
    pub reading: Option<Reading<wire::PhotosAlbums>>,
    pub folded: Vec<String>,
    pub new_album_name: String,
    /// The album a delete confirm is asking about.
    pub deleting: Option<String>,
}

impl Collections {
    pub fn read(&mut self, ctx: &Ctx) {
        self.reading = Some(read::read(
            ctx,
            load::photos::Albums::default(),
            |answer| match answer {
                Answer::PhotosAlbums(albums) => Some(*albums),
                _ => None,
            },
        ));
    }

    pub fn toggle(&mut self, section: &str) {
        if let Some(at) = self.folded.iter().position(|folded| folded == section) {
            self.folded.remove(at);
        } else if SECTIONS.contains(&section) {
            self.folded.push(section.to_owned());
        }
    }

    /// "Show all" / "Collapse all": when every section is folded they all open,
    /// otherwise they all fold.
    pub fn fold_all(&mut self) {
        if SECTIONS
            .iter()
            .all(|section| self.folded.iter().any(|f| f == section))
        {
            self.folded.clear();
        } else {
            self.folded = SECTIONS
                .iter()
                .map(|section| (*section).to_owned())
                .collect();
        }
    }

    /// `container.create` of an album. An empty name is not a write: the vault's
    /// `title` is `minLength: 1`, and a command a screen KNOWS will be refused is
    /// a round trip a member waits through for nothing. Loads and writes are
    /// synchronous, so a double tap reaches here after the sheet has gone.
    ///
    /// # Errors
    /// The vault's sentence for a refused create.
    pub fn create(&mut self, ctx: &Ctx) -> Result<bool, String> {
        let name = self.new_album_name.trim().to_owned();
        if name.is_empty() {
            return Ok(false);
        }
        let key = kit_act::key(&["create-album", &name], kit_act::fresh());
        let settled = kit_act::act(
            ctx,
            act::photos::CreateAlbum {
                title: name,
                id: None,
            },
            &key,
        );
        if settled.committed {
            self.new_album_name.clear();
            Ok(true)
        } else {
            Err(settled.refusal)
        }
    }

    /// Delete an album: its photographs stay in the library, and it comes back
    /// from the trash with its ordered photographs.
    ///
    /// # Errors
    /// The vault's sentence for a refused delete.
    pub fn delete(ctx: &Ctx, album_id: &str) -> Result<(), String> {
        let key = kit_act::key(&["delete-album", album_id], kit_act::fresh());
        let settled = kit_act::act(
            ctx,
            act::photos::DeleteAlbum {
                album_id: album_id.to_owned(),
            },
            &key,
        );
        if settled.committed {
            Ok(())
        } else {
            Err(settled.refusal)
        }
    }

    /// Bring a trashed album back, with its ordered photographs.
    ///
    /// # Errors
    /// The vault's sentence for a refused restore.
    pub fn restore(ctx: &Ctx, album_id: &str) -> Result<(), String> {
        let key = kit_act::key(&["restore-album", album_id], kit_act::fresh());
        let settled = kit_act::act(
            ctx,
            act::photos::RestoreAlbum {
                album_id: album_id.to_owned(),
            },
            &key,
        );
        if settled.committed {
            Ok(())
        } else {
            Err(settled.refusal)
        }
    }

    pub fn view(&self, locale: Locale, link: Link) -> wire::PhotosCollections {
        let content = match &self.reading {
            None => wire::photos_collections::Content::Loading(wire::Loading { first_load: true }),
            Some(Reading::Data(albums)) => {
                wire::photos_collections::Content::Data(wire::PhotosCollectionsData {
                    sections: self.sections(locale, link, albums),
                })
            }
            Some(Reading::Denied(_) | Reading::Failed) => {
                wire::photos_collections::Content::Failure(read::failure(locale))
            }
        };
        wire::PhotosCollections {
            content: Some(content),
            folded: self.folded.clone(),
            new_album_name: self.new_album_name.clone(),
            new_album_can_submit: !self.new_album_name.trim().is_empty(),
            delete_confirm: self.deleting.as_ref().map(|_| wire::Confirm {
                title: words::photos_delete_album_title(locale),
                body: words::photos_delete_album_body(locale),
                confirm_label: words::photos_delete_album(locale),
                destructive: true,
            }),
            delete_album_id: self.deleting.clone().unwrap_or_default(),
        }
    }

    fn sections(
        &self,
        locale: Locale,
        link: Link,
        albums: &wire::PhotosAlbums,
    ) -> Vec<wire::PhotosCollectionsSection> {
        let folded = |key: &str| self.folded.iter().any(|f| f == key);
        let toggle = |title: &str, key: &str| {
            fill(
                &if folded(key) {
                    words::photos_section_show(locale)
                } else {
                    words::photos_section_hide(locale)
                },
                &[("title", title)],
            )
        };
        let section = |key: &str, title: String, cards: Vec<wire::PhotosCollectionCard>| {
            wire::PhotosCollectionsSection {
                key: key.to_owned(),
                toggle_label: toggle(&title, key),
                title,
                folded: folded(key),
                cards,
                empty: None,
            }
        };

        let shelf = |kind: wire::PhotosShelfKind,
                     title: String,
                     tile: &wire::PhotosShelfTile,
                     icon: &str| {
            let count_label = if tile.count == 0 {
                words::photos_count_empty(locale)
            } else {
                tile.count.to_string()
            };
            wire::PhotosCollectionCard {
                kind: Kind::Shelf as i32,
                id: String::new(),
                accessibility_label: format!(
                    "{title}, {}",
                    cells::count_phrase(locale, tile.count, false)
                ),
                title: title.clone(),
                count_label,
                cover: tile.cover.as_ref().map(|c| cells::tile(c, link, locale)),
                route: Some(routes::shelf(kind, "", &title)),
                icon_key: icon.to_owned(),
                ..wire::PhotosCollectionCard::default()
            }
        };
        let door =
            |kind: Kind, title: String, count: u32, urgent: u32, route: wire::Route, icon: &str| {
                let count_label = if urgent > 0 {
                    fill(
                        &words::photos_waiting(locale),
                        &[("count", &urgent.to_string())],
                    )
                } else if count > 0 {
                    count.to_string()
                } else {
                    String::new()
                };
                wire::PhotosCollectionCard {
                    kind: kind as i32,
                    accessibility_label: format!("{title}, {count_label}"),
                    title,
                    count_label,
                    route: Some(route),
                    icon_key: icon.to_owned(),
                    urgent: urgent > 0,
                    ..wire::PhotosCollectionCard::default()
                }
            };

        let mut pinned = vec![
            shelf(
                wire::PhotosShelfKind::Favorites,
                sentences::library_standing_favorites(locale),
                albums
                    .favorites
                    .as_ref()
                    .unwrap_or(&wire::PhotosShelfTile::default()),
                "Heart",
            ),
            shelf(
                wire::PhotosShelfKind::Videos,
                sentences::library_standing_videos(locale),
                albums
                    .videos
                    .as_ref()
                    .unwrap_or(&wire::PhotosShelfTile::default()),
                "Play",
            ),
        ];
        // PLACES AFTER THE SECOND STANDING SHELF, where the system puts Map.
        pinned.insert(
            pinned.len().min(2),
            door(
                Kind::Places,
                sentences::library_door_places(locale),
                albums.places,
                0,
                routes::places(),
                "MapPin",
            ),
        );
        let utilities = vec![
            door(
                Kind::Duplicates,
                sentences::library_door_duplicates(locale),
                albums.duplicate_clusters,
                albums.duplicate_clusters,
                routes::duplicates(),
                "Copy",
            ),
            shelf(
                wire::PhotosShelfKind::Archive,
                sentences::library_standing_archive(locale),
                albums
                    .archive
                    .as_ref()
                    .unwrap_or(&wire::PhotosShelfTile::default()),
                "Archive",
            ),
            shelf(
                wire::PhotosShelfKind::Trash,
                sentences::library_standing_trash(locale),
                albums
                    .trash
                    .as_ref()
                    .unwrap_or(&wire::PhotosShelfTile::default()),
                "Trash",
            ),
        ];

        let album_cards: Vec<wire::PhotosCollectionCard> = albums
            .albums
            .iter()
            .map(|album| {
                let title = if album.title.is_empty() {
                    words::photos_untitled_album(locale)
                } else {
                    album.title.clone()
                };
                let count_label = cells::count_phrase(locale, album.count, false);
                wire::PhotosCollectionCard {
                    kind: Kind::Album as i32,
                    id: album.album_id.clone(),
                    accessibility_label: format!("{title}, {count_label}"),
                    count_label,
                    cover: album.cover.as_ref().map(|c| cells::tile(c, link, locale)),
                    route: Some(routes::shelf(
                        wire::PhotosShelfKind::Album,
                        &album.album_id,
                        &title,
                    )),
                    member_owned: true,
                    icon_key: "Image".to_owned(),
                    delete_label: words::photos_delete_album(locale),
                    title,
                    ..wire::PhotosCollectionCard::default()
                }
            })
            .collect();

        let mut out = vec![
            section(PINNED, words::photos_pinned(locale), pinned),
            {
                let mut albums_section = section(ALBUMS, words::photos_albums(locale), album_cards);
                if albums_section.cards.is_empty() {
                    albums_section.empty = Some(wire::EmptyState {
                        headline: words::photos_collections_no_albums(locale),
                        body: words::photos_collections_no_albums_caption(locale),
                        action_label: words::photos_create(locale),
                        ..wire::EmptyState::default()
                    });
                }
                albums_section
            },
            section(UTILITIES, words::photos_utilities(locale), utilities),
        ];
        if !albums.trashed_albums.is_empty() {
            let cards = albums
                .trashed_albums
                .iter()
                .map(|album| {
                    let title = if album.title.is_empty() {
                        words::photos_untitled_album(locale)
                    } else {
                        album.title.clone()
                    };
                    let count_label = match album.purge_in_days {
                        Some(1) => sentences::library_albums_trash_purge_one(locale),
                        Some(days) if days > 1 => fill(
                            &sentences::library_albums_trash_purge(locale),
                            &[("days", &days.to_string())],
                        ),
                        Some(_) => sentences::library_albums_trash_soon(locale),
                        None => String::new(),
                    };
                    wire::PhotosCollectionCard {
                        kind: Kind::DeletedAlbum as i32,
                        id: album.album_id.clone(),
                        accessibility_label: format!("{title}, {count_label}"),
                        count_label,
                        restore_label: sentences::library_albums_restore(locale),
                        icon_key: "Image".to_owned(),
                        title,
                        ..wire::PhotosCollectionCard::default()
                    }
                })
                .collect();
            out.push(section(
                DELETED,
                sentences::library_albums_trash(locale),
                cards,
            ));
        }
        out
    }
}
