//! HEALTH'S TRASH: the kit's one trash screen with Health as the parameter (#1185).
//!
//! `delete-workout` (`entity.trash`) moves a workout here for 30 days from its page,
//! `restore-workout` brings it back, `purge-workout` (`entity.purge`) deletes one forever and
//! `empty-trash` (`entity.empty_trash`, kind activity having a workout row: exactly what the list shows, never a touch trashed with its person) every trashed workout, each behind the kit's
//! destructive confirm. A workout a health store states is the member's to trash like any other: the
//! store's next read leaves it in the trash (the follower never restores what the member trashed).
//! The list is the core's `health.trash`; a row is named as the Workouts list names it ("Morning run").

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use super::figures;
use crate::catalog::{act, load};
use crate::kit::civil;
use crate::kit::read::{self, Reading};
use crate::kit::trash::{self, TrashItem, TrashSpec};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, health as words, shared};

/// Health's trash, as the kit's screen takes it.
pub static SPEC: TrashSpec = TrashSpec {
    app: act::health::APP,
    icon_key: "Activity",
    noun: shared::trash_noun_workout,
    purge_lead: None,
    back_label: words::app_title,
    denied: super::denied,
    load: trashed,
    trash: |id| {
        act::health::DeleteWorkout {
            workout_id: id.to_owned(),
        }
        .into()
    },
    restore: |id| {
        act::health::RestoreWorkout {
            workout_id: id.to_owned(),
        }
        .into()
    },
    purge: |id| {
        act::health::PurgeWorkout {
            workout_id: id.to_owned(),
        }
        .into()
    },
    empty: || {
        act::health::EmptyTrash {
            kind: Some(act::health::EmptyTrashKind::Activity),
            having: Some(act::health::EmptyTrashHaving::Workout),
            ..Default::default()
        }
        .into()
    },
};

#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    trash::build(&SPEC)
}

/// "Morning run": the kind and the part of the day it started in, as the Workouts list says it.
#[must_use]
pub fn title_of(ctx: &Ctx, locale: Locale, kind_key: &str, local_start: &str) -> String {
    figures::title(
        locale,
        kind_key,
        &civil::clock_for(locale, local_start, ctx.hour_cycle()),
    )
}

/// `health.trash`: the trashed workouts, most recently trashed first.
fn trashed(ctx: &Ctx) -> Reading<Vec<TrashItem>> {
    let locale = ctx.locale();
    match read::read(ctx, load::health::Trash::default(), |answer| match answer {
        Answer::HealthTrash(trash) => Some(trash),
        _ => None,
    }) {
        Reading::Data(trash) => Reading::Data(
            trash
                .workouts
                .into_iter()
                .map(|row| TrashItem {
                    title: title_of(ctx, locale, &row.kind_key, &row.local_start),
                    id: row.activity_id,
                    deleted_day: row.deleted_local_day,
                    purge_day: row.purge_local_day,
                    noun: None,
                })
                .collect(),
        ),
        Reading::Denied(denial) => Reading::Denied(denial),
        Reading::Failed => Reading::Failed,
    }
}
