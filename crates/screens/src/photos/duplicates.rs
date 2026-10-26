//! `photos.duplicates` (#1135): the near-duplicate sets, one row each, ordered by
//! what resolving them gives back. A list of decisions and not of photographs:
//! nothing here deletes anything (the verb lives on `photos.duplicate_review`,
//! which shows the differences).
//!
//! The clustering is the core's (`photos.duplicates`, recomputed at read); this
//! screen reads it and stops, so a second implementation can never disagree with
//! it at the boundary where a member is deciding what to delete.
//!
//! Dropped with the Kotlin machine: the seat, the page cursor (one answer holds
//! every set), the cover and byte legs (the answer's members are finished cells
//! carrying thumbnails and sizes), and `scan_complete` (the projection is
//! computed at read; nothing records a pass, so "still looking" can never be
//! said truthfully).

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::photos_duplicates_event::Kind as K;
use wire::screen_event::Kind as E;

use super::cells::{self, Link};
use super::{media, routes};
use crate::catalog::load;
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, photos as words, photos_lightbox as own};

#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    Some(Box::new(Duplicates {
        content: Content::Loading,
    }))
}

enum Content {
    Loading,
    Failed,
    Denied(wire::AppQueryDenial),
    Data(Vec<wire::PhotosDuplicateCluster>),
}

struct Duplicates {
    content: Content,
}

/// What resolving a cluster gives back: every copy's bytes less the largest, or
/// `None` when any copy's size is unknown (never "0 bytes").
#[must_use]
pub fn reclaimable(cluster: &wire::PhotosDuplicateCluster) -> Option<i64> {
    let mut total = 0_i64;
    let mut largest = 0_i64;
    for member in &cluster.members {
        let size = member.byte_size.filter(|size| *size > 0)?;
        total += size;
        largest = largest.max(size);
    }
    (!cluster.members.is_empty()).then_some(total - largest)
}

impl Duplicates {
    fn reload(&mut self, ctx: &Ctx) {
        let reading = read::read(
            ctx,
            load::photos::Duplicates::default(),
            |answer| match answer {
                Answer::PhotosDuplicates(found) => Some(found.clusters),
                _ => None,
            },
        );
        match reading {
            Reading::Data(mut clusters) => {
                // Most worth doing first; a cluster whose size is unknown sorts
                // after every known one, then the bigger job, then the key.
                clusters.sort_by(|a, b| {
                    reclaimable(b)
                        .cmp(&reclaimable(a))
                        .then(b.photo_ids.len().cmp(&a.photo_ids.len()))
                        .then(a.key.cmp(&b.key))
                });
                self.content = Content::Data(clusters);
            }
            Reading::Denied(denial) => self.content = Content::Denied(denial),
            Reading::Failed => self.content = Content::Failed,
        }
    }

    fn set(locale: Locale, cluster: &wire::PhotosDuplicateCluster) -> wire::PhotosDuplicateSet {
        let count = cluster.photo_ids.len().max(cluster.members.len());
        let headline = own::duplicate_copies(locale, count as u64);
        let subhead = match reclaimable(cluster) {
            Some(bytes) => fill(
                &words::photos_to_reclaim(locale),
                &[("size", &media::bytes_phrase(locale, bytes))],
            ),
            None => words::photos_duplicates_pick_one(locale),
        };
        wire::PhotosDuplicateSet {
            cluster_key: cluster.key.clone(),
            accessibility_label: format!("{headline}. {subhead}"),
            headline,
            subhead,
            cover: cluster
                .members
                .iter()
                .find(|cell| {
                    cell.thumbnail_path
                        .as_deref()
                        .is_some_and(|p| !p.is_empty())
                })
                .or(cluster.members.first())
                .map(|cell| cells::tile(cell, Link::default(), locale)),
            route: Some(routes::duplicate_review(&cluster.key)),
        }
    }
}

impl Screen for Duplicates {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                self.reload(ctx);
            }
            Some(E::PhotosDuplicates(event)) if matches!(event.kind, Some(K::Refreshed(_))) => {
                self.reload(ctx);
            }
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let content = match &self.content {
            Content::Loading => {
                wire::photos_duplicates_state::Content::Loading(wire::Loading { first_load: true })
            }
            Content::Failed => {
                wire::photos_duplicates_state::Content::Failure(read::failure(locale))
            }
            Content::Denied(denial) => {
                wire::photos_duplicates_state::Content::Denied(wire::Denied {
                    title: own::denied_title(locale),
                    body: own::denied_body(locale),
                    receipt: denial.code.clone().unwrap_or_default(),
                })
            }
            Content::Data(clusters) => {
                let sets: Vec<_> = clusters.iter().map(|c| Self::set(locale, c)).collect();
                let reclaim = clusters
                    .iter()
                    .map(reclaimable)
                    .try_fold(0_i64, |sum, each| each.map(|bytes| sum + bytes))
                    .filter(|bytes| *bytes > 0 && !clusters.is_empty())
                    .map(|bytes| {
                        fill(
                            &words::photos_to_reclaim(locale),
                            &[("size", &media::bytes_phrase(locale, bytes))],
                        )
                    })
                    .unwrap_or_default();
                wire::photos_duplicates_state::Content::Data(Box::new(wire::PhotosDuplicatesData {
                    lede: if sets.is_empty() {
                        String::new()
                    } else {
                        words::duplicate_sets(locale, sets.len() as u64)
                    },
                    reclaim,
                    empty: sets.is_empty().then(|| wire::EmptyState {
                        headline: words::photos_empty_duplicates(locale),
                        body: words::photos_duplicates_none_caption(locale),
                        ..Default::default()
                    }),
                    sets,
                }))
            }
        };
        wire::ViewState {
            instance: 0,
            revision: 0,
            kind: Some(wire::view_state::Kind::PhotosDuplicates(
                wire::PhotosDuplicatesState {
                    title: words::photos_duplicates(locale),
                    content: Some(content),
                },
            )),
        }
    }
}
