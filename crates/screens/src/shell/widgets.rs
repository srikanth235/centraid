//! Device-local widget layout. The native menu sends a choice; Rust validates,
//! orders, sizes and persists it, independent of the order app reads finish.

use centraid_api_proto::core_v1 as wire;

use super::policy;
use crate::strings::{Locale, home as words};
use wire::HomeTileSize as Size;
use wire::home_event::WidgetChanged;
use wire::home_event::widget_changed::Position;

pub const KEY: &str = "home-widgets";

/// The compact card uses a value and caption from the same app read as its
/// expanded body. In particular, a missing read is never rendered as zero.
pub fn compact(made: &super::tiles::Made, name: &str) -> (String, String) {
    use wire::home_tile_body::Kind;
    match &made.body {
        Some(Kind::Health(body)) => (body.figure.clone(), body.caption.clone()),
        Some(Kind::Money(body)) => (body.amounts.join(" · "), body.caption.clone()),
        Some(Kind::Locker(body)) => (body.state_label.clone(), name.to_owned()),
        _ => (
            made.count.map_or_else(
                || "—".to_owned(),
                |count| format!("{}{}", count.value, if count.capped { "+" } else { "" }),
            ),
            name.to_owned(),
        ),
    }
}

pub fn agenda_snapshot(locale: Locale, tiles: &[wire::HomeTile]) -> wire::AgendaWidgetSnapshot {
    let tile = tiles.iter().find(|tile| tile.app_id == "agenda");
    let agenda =
        tile.and_then(|tile| tile.body.as_ref())
            .and_then(|body| match body.kind.as_ref() {
                Some(wire::home_tile_body::Kind::Agenda(agenda)) => Some(agenda),
                _ => None,
            });
    let reminders = tiles
        .iter()
        .find(|tile| tile.app_id == "reminders")
        .and_then(|tile| tile.body.as_ref())
        .and_then(|body| match body.kind.as_ref() {
            Some(wire::home_tile_body::Kind::Agenda(agenda)) => Some(agenda),
            _ => None,
        });
    wire::AgendaWidgetSnapshot {
        title: words::widget_agenda(locale),
        event_title: agenda.map_or_else(
            || {
                if tile.is_some_and(|tile| tile.status() == wire::HomeTileStatus::Empty) {
                    words::tile_agenda_no_events(locale)
                } else {
                    words::widget_empty(locale)
                }
            },
            |agenda| agenda.title.clone(),
        ),
        event_when: agenda.map(|agenda| agenda.at.clone()).unwrap_or_default(),
        reminders: reminders
            .map(|agenda| agenda.due_label.clone())
            .unwrap_or_default(),
        reminder_title: reminders
            .map(|agenda| agenda.due_title.clone())
            .unwrap_or_default(),
        open_label: words::widget_open(locale),
        new_label: words::widget_new(locale),
        empty_label: words::widget_empty(locale),
        updated_label: words::widget_updated(locale),
    }
}

pub struct Layout(Vec<(String, Size)>);

impl Layout {
    pub fn read(value: Option<&str>) -> Self {
        let mut entries = Vec::new();
        for line in value.unwrap_or_default().lines() {
            let Some((app, raw)) = line.split_once('\t') else {
                continue;
            };
            if !policy::WIDGETS.contains(&app) || entries.iter().any(|(id, _)| id == app) {
                continue;
            }
            let size = match raw {
                "small" => Size::Small,
                "medium" => Size::Medium,
                "large" => Size::Large,
                _ => policy::size_of(app),
            };
            entries.push((app.to_owned(), size));
        }
        for app in policy::WIDGETS {
            if !entries.iter().any(|(id, _)| id == app) {
                entries.push((app.to_owned(), policy::size_of(app)));
            }
        }
        Self(entries)
    }

    pub fn change(&mut self, choice: &WidgetChanged) -> bool {
        let Some(index) = self.0.iter().position(|(app, _)| app == &choice.app_id) else {
            return false;
        };
        if choice.size() != Size::Unspecified {
            self.0[index].1 = choice.size();
        }
        match choice.position() {
            Position::Unspecified => {}
            Position::First => {
                let entry = self.0.remove(index);
                self.0.insert(0, entry);
            }
            Position::Last => {
                let entry = self.0.remove(index);
                self.0.push(entry);
            }
        }
        true
    }

    pub fn stored(&self) -> String {
        self.0
            .iter()
            .map(|(app, size)| {
                let size = match size {
                    Size::Small | Size::Unspecified => "small",
                    Size::Medium => "medium",
                    Size::Large => "large",
                };
                format!("{app}\t{size}")
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub fn apply(&self, tiles: &mut [wire::HomeTile], locale: Locale) {
        tiles.sort_by_key(|tile| self.0.iter().position(|(app, _)| app == &tile.app_id));
        for tile in tiles {
            let Some((index, (_, size))) = self
                .0
                .iter()
                .enumerate()
                .find(|(_, (app, _))| app == &tile.app_id)
            else {
                continue;
            };
            tile.size = *size as i32;
            tile.column_span = policy::span(*size);
            let action = |label, size: Size, position: Position| wire::HomeWidgetAction {
                label,
                selected: size != Size::Unspecified && size as i32 == tile.size,
                change: Some(WidgetChanged {
                    app_id: tile.app_id.clone(),
                    size: size as i32,
                    position: position as i32,
                }),
            };
            let mut actions = vec![
                action(
                    words::widget_small(locale),
                    Size::Small,
                    Position::Unspecified,
                ),
                action(
                    words::widget_medium(locale),
                    Size::Medium,
                    Position::Unspecified,
                ),
                action(
                    words::widget_large(locale),
                    Size::Large,
                    Position::Unspecified,
                ),
            ];
            if index != 0 {
                actions.push(action(
                    words::widget_first(locale),
                    Size::Unspecified,
                    Position::First,
                ));
            }
            if index + 1 != self.0.len() {
                actions.push(action(
                    words::widget_last(locale),
                    Size::Unspecified,
                    Position::Last,
                ));
            }
            tile.widget_actions = actions;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unreadable_widget_never_claims_there_are_no_events() {
        let mut tile = wire::HomeTile {
            app_id: "agenda".into(),
            status: wire::HomeTileStatus::Unknown as i32,
            ..Default::default()
        };
        let unknown = agenda_snapshot(Locale::En, &[tile.clone()]);
        assert_eq!(unknown.event_title, unknown.empty_label);
        tile.status = wire::HomeTileStatus::Empty as i32;
        assert_eq!(
            agenda_snapshot(Locale::En, &[tile]).event_title,
            "No events coming up"
        );
    }

    #[test]
    fn os_snapshot_keeps_calendar_and_reminder_previews_from_their_own_reads() {
        let tile = |app: &str, body| wire::HomeTile {
            app_id: app.into(),
            status: wire::HomeTileStatus::Content as i32,
            body: Some(wire::HomeTileBody {
                kind: Some(wire::home_tile_body::Kind::Agenda(body)),
            }),
            ..Default::default()
        };
        let snapshot = agenda_snapshot(
            Locale::En,
            &[
                tile(
                    "agenda",
                    wire::home_tile_body::Agenda {
                        title: "Dentist".into(),
                        at: "14:00".into(),
                        ..Default::default()
                    },
                ),
                tile(
                    "reminders",
                    wire::home_tile_body::Agenda {
                        due_count: 2,
                        due_label: "2 due".into(),
                        due_title: "Call home".into(),
                        ..Default::default()
                    },
                ),
            ],
        );
        assert_eq!(
            (snapshot.event_title.as_str(), snapshot.event_when.as_str()),
            ("Dentist", "14:00")
        );
        assert_eq!(
            (
                snapshot.reminders.as_str(),
                snapshot.reminder_title.as_str()
            ),
            ("2 due", "Call home")
        );
    }

    #[test]
    fn a_saved_photos_first_layout_keeps_its_order_and_sizes() {
        let saved = "photos\tlarge\nagenda\tmedium\nreminders\tmedium\nmoney\tsmall\nhealth\tsmall\npeople\tsmall\nlocker\tsmall\nnotes\tmedium\ndocs\tmedium";
        assert_eq!(Layout::read(Some(saved)).stored(), saved);
    }

    #[test]
    fn layout_round_trip_keeps_order_and_size_without_unknown_or_duplicate_apps() {
        let mut layout = Layout::read(Some("notes\tsmall\nunknown\tlarge\nnotes\tlarge"));
        assert!(layout.change(&WidgetChanged {
            app_id: "money".into(),
            size: Size::Large as i32,
            position: Position::First as i32,
        }));
        let stored = layout.stored();
        assert!(stored.starts_with("money\tlarge\nnotes\tsmall"));
        assert_eq!(stored.lines().count(), policy::WIDGETS.len());
        assert_eq!(Layout::read(Some(&stored)).stored(), stored);
        assert!(!layout.change(&WidgetChanged {
            app_id: "unknown".into(),
            ..Default::default()
        }));
    }
}
