//! `photos.duplicate_review` (#1135): one near-duplicate set and the decision
//! that trashes a member's photographs. Three things are kept apart because
//! getting any of them wrong costs somebody their photographs:
//!
//! 1. NOTHING IS KEPT UNTIL THE MEMBER PICKS. The resolve is disabled, and says
//!    why, until then; a pick that left the set is forgotten.
//! 2. THE SUGGESTION IS A REMARK ON A ROW, NEVER A PICK: the largest by pixels,
//!    and none when nothing has a pixel box or two tie.
//! 3. TRASH IS NOT PURGE: `delete-photo` per other copy, never `purge-photo`.
//!    No merge verb exists; resolving is exactly "trash the others".
//!
//! The set is the core's cluster by key. Its members are finished cells, so the
//! albums that hold each copy come with them: `placements_checked` is always
//! true and the Kotlin placement leg is gone, as are the seat and the read
//! plumbing. A set that no longer exists (its copies were trashed here or
//! elsewhere) is an empty set, not a failure.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::photos_duplicate_review_event::Kind as K;
use wire::screen_event::Kind as E;

use super::cells::{self, Link};
use super::media;
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, photos as words, photos_lightbox as own};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::PhotosDuplicateReview(args)) = &route.args else {
        return None;
    };
    Some(Box::new(Review {
        key: args.cluster_key.clone(),
        content: Content::Loading,
        keep: String::new(),
        status: None,
    }))
}

enum Content {
    Loading,
    Failed,
    Denied(wire::AppQueryDenial),
    Data(Vec<wire::PhotosCell>),
}

struct Review {
    key: String,
    content: Content,
    keep: String,
    status: Option<wire::StatusLine>,
}

/// The largest member by pixel area; `None` when no member has a box or two tie
/// at the largest (picking between them would be the product choosing).
#[must_use]
pub fn suggested_keep(members: &[wire::PhotosCell]) -> Option<&str> {
    let area = |cell: &wire::PhotosCell| match (cell.width, cell.height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => Some(w * h),
        _ => None,
    };
    let largest = members.iter().filter_map(area).max()?;
    let mut winners = members.iter().filter(|cell| area(cell) == Some(largest));
    let first = winners.next()?;
    winners.next().is_none().then_some(first.photo_id.as_str())
}

impl Review {
    fn ids(&self) -> Vec<&str> {
        match &self.content {
            Content::Data(members) => members.iter().map(|m| m.photo_id.as_str()).collect(),
            _ => Vec::new(),
        }
    }

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
            Reading::Data(clusters) => {
                let members = clusters
                    .into_iter()
                    .find(|cluster| cluster.key == self.key)
                    .map(|cluster| cluster.members)
                    .unwrap_or_default();
                if !self.keep.is_empty()
                    && !members.iter().any(|member| member.photo_id == self.keep)
                {
                    self.keep.clear();
                }
                self.content = Content::Data(members);
            }
            Reading::Denied(denial) => self.content = Content::Denied(denial),
            Reading::Failed => self.content = Content::Failed,
        }
    }

    /// Trash every copy but the kept one: one `delete-photo` each, so a batch
    /// that half-committed leaves exactly the copies that did not go, and the
    /// first refusal's sentence stands beside them.
    fn resolve(&mut self, ctx: &Ctx) {
        let Content::Data(members) = &self.content else {
            return;
        };
        if self.keep.is_empty() || !members.iter().any(|m| m.photo_id == self.keep) {
            return;
        }
        let doomed: Vec<String> = members
            .iter()
            .map(|m| m.photo_id.clone())
            .filter(|id| !id.is_empty() && *id != self.keep)
            .collect();
        if doomed.is_empty() {
            return;
        }
        self.status = None;
        for id in doomed {
            let key = kit_act::key(&["delete-photo", &id], kit_act::fresh());
            let settled = kit_act::act(ctx, act::photos::DeletePhoto { photo_id: id }, &key);
            if !settled.committed && self.status.is_none() {
                let sentence = if settled.refusal.is_empty() {
                    own::review_trash_failed(ctx.locale())
                } else {
                    settled.refusal
                };
                self.status = Some(wire::StatusLine {
                    sentence,
                    action_label: String::new(),
                    refused: true,
                });
            }
        }
        self.reload(ctx);
    }

    fn member(
        &self,
        locale: Locale,
        cell: &wire::PhotosCell,
        suggested: Option<&str>,
        reason: &str,
    ) -> wire::PhotosDuplicateMember {
        let pixels = match (cell.width, cell.height) {
            (Some(w), Some(h)) if w > 0 && h > 0 => fill(
                &own::duplicate_pixels(locale),
                &[("width", &w.to_string()), ("height", &h.to_string())],
            ),
            _ => String::new(),
        };
        let size = cell
            .byte_size
            .filter(|size| *size > 0)
            .map(|size| media::bytes_phrase(locale, size))
            .unwrap_or_default();
        let facts = [pixels, size]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" · ");
        let facts = if facts.is_empty() {
            words::photos_review_this_copy(locale)
        } else {
            facts
        };
        let offset = cell.offset_min.unwrap_or(0);
        let captured = match cell.taken_at.as_deref() {
            Some(at) if !cells::capture_day(at, offset).is_empty() => fill(
                &own::duplicate_captured(locale),
                &[
                    ("date", &media::stamp_date(locale, at, offset)),
                    ("clock", &cells::capture_clock(at, offset)),
                ],
            ),
            _ => words::photos_review_no_capture_time(locale),
        };
        let in_album = !cell.album_ids.is_empty();
        let kept = self.keep == cell.photo_id;
        let suggestion = if suggested == Some(cell.photo_id.as_str()) {
            reason.to_owned()
        } else {
            String::new()
        };
        let accessibility_label = [
            facts.clone(),
            captured.clone(),
            if in_album {
                words::photos_review_in_album(locale)
            } else {
                String::new()
            },
            suggestion.clone(),
            if kept {
                words::photos_review_keeping(locale)
            } else {
                String::new()
            },
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(". ");
        wire::PhotosDuplicateMember {
            photo_id: cell.photo_id.clone(),
            tile: Some(cells::tile(cell, Link::default(), locale)),
            facts,
            captured,
            in_album,
            in_album_label: if in_album {
                words::photos_review_in_album(locale)
            } else {
                String::new()
            },
            kept,
            suggestion,
            accessibility_label,
        }
    }
}

impl Screen for Review {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                self.reload(ctx);
            }
            Some(E::PhotosDuplicateReview(event)) => match event.kind {
                Some(K::Refreshed(_)) => self.reload(ctx),
                Some(K::Keep(picked)) => {
                    if self.ids().contains(&picked.photo_id.as_str()) {
                        self.keep = picked.photo_id;
                        self.status = None;
                    }
                }
                Some(K::Resolve(_)) => self.resolve(ctx),
                None => {}
            },
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        use wire::photos_duplicate_review_state::Content as C;
        let content = match &self.content {
            Content::Loading => C::Loading(wire::Loading { first_load: true }),
            Content::Failed => C::Failure(read::failure(locale)),
            Content::Denied(denial) => C::Denied(wire::Denied {
                title: own::denied_title(locale),
                body: own::denied_body(locale),
                receipt: denial.code.clone().unwrap_or_default(),
            }),
            Content::Data(members) => {
                let suggested = suggested_keep(members);
                let reason = if suggested.is_some() {
                    own::review_suggestion(locale)
                } else {
                    String::new()
                };
                let picked = !self.keep.is_empty();
                let others = members.len().saturating_sub(1);
                let resolve_label = if !picked {
                    words::photos_review_trash_others(locale)
                } else if others == 1 {
                    words::photos_review_trash_other(locale)
                } else {
                    words::review_trash_others(locale, others as u64)
                };
                C::Data(Box::new(wire::PhotosDuplicateReviewData {
                    members: members
                        .iter()
                        .map(|cell| self.member(locale, cell, suggested, &reason))
                        .collect(),
                    pick_line: words::photos_review_pick(locale),
                    pick_caption: words::photos_review_pick_caption(locale),
                    checked_line: words::photos_review_checked(locale),
                    suggested_photo_id: suggested.unwrap_or_default().to_owned(),
                    suggestion_reason: reason,
                    keep_photo_id: self.keep.clone(),
                    resolve_label,
                    resolve_enabled: picked && others > 0,
                    resolve_hint: if picked {
                        String::new()
                    } else {
                        words::photos_review_choose_first(locale)
                    },
                    empty: members.is_empty().then(|| wire::EmptyState {
                        headline: words::photos_review_none(locale),
                        body: words::photos_review_none_caption(locale),
                        ..Default::default()
                    }),
                }))
            }
        };
        wire::ViewState {
            instance: 0,
            revision: 0,
            kind: Some(wire::view_state::Kind::PhotosDuplicateReview(
                wire::PhotosDuplicateReviewState {
                    cluster_key: self.key.clone(),
                    title: words::photos_duplicates(locale),
                    content: Some(content),
                    status: self.status.clone(),
                },
            )),
        }
    }
}
