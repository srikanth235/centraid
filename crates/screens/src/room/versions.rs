use centraid_api_proto::core_v1 as wire;
use centraid_domain::apps::entity as entity_reads;
use centraid_domain::read::Args;
use serde_json::json;

use super::blocks::{self, glyph};
use super::frame::room;
use super::screen::{Build, Event, Input, Outcome, RoomScreen};
use super::selector::{Act, Handler};
use crate::strings::{Locale, shared};

const EN: Locale = Locale::En;

pub fn page(key: &str, id: &str, parent_title: &str) -> Box<dyn RoomScreen> {
    Box::new(VersionPage {
        key: key.to_owned(),
        id: id.to_owned(),
        parent_title: parent_title.to_owned(),
    })
}

struct VersionPage {
    key: String,
    id: String,
    parent_title: String,
}

impl RoomScreen for VersionPage {
    fn key(&self) -> String {
        self.key.clone()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let revisions = match b.run(&entity_reads::REVISIONS, &Args::new().text("id", &self.id)) {
            Ok(answer) => answer.rows,
            Err(error) => {
                return room(wire::RoomKind::PushedPage, &self.key)
                    .title(&shared::versions_title(EN))
                    .back(&mut b.sel, &self.parent_title)
                    .failed(&mut b.sel, &error.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let content = if revisions.is_empty() {
            vec![blocks::empty(
                glyph("History", ""),
                &shared::empty_versions_title(EN),
                &shared::empty_versions_body(EN),
                None,
            )]
        } else {
            let rows: Vec<wire::RoomBlock> = revisions
                .iter()
                .map(|revision| {
                    let seq = revision.seq;
                    blocks::row(
                        &mut b.sel,
                        &format!("version/{seq}"),
                        revision.at.get(..10).unwrap_or(&revision.at),
                        Handler::Act(Act::new(
                            "history.restore_version",
                            json!({ "id": self.id, "seq": seq }),
                        )),
                    )
                    .meta(&revision.actor)
                    .trailing(&shared::restore_version(EN), wire::RoomTone::Accent)
                    .into_block()
                })
                .collect();
            vec![
                blocks::section(
                    &mut b.sel,
                    "section/versions",
                    &shared::section_versions(EN),
                )
                .blocks(rows)
                .into_block(),
            ]
        };
        room(wire::RoomKind::PushedPage, &self.key)
            .title(&shared::versions_title(EN))
            .back(&mut b.sel, &self.parent_title)
            .ready(content)
            .build()
    }

    fn on(&mut self, _: &mut Event<'_>, _: &str, _: &Input) -> Outcome {
        Outcome::default()
    }
}

pub fn key(app: &str, kind: &str, id: &str) -> String {
    format!("{app}/{kind}/{id}/versions")
}

#[cfg(test)]
mod tests {
    #[test]
    fn promised_app_routes_resolve_to_the_shared_versions_page() {
        let routes = [
            (super::super::money::registry(), "money/txn/id/versions"),
            (super::super::people::registry(), "person/id/versions"),
            (
                super::super::calendar::registry(),
                "calendar/event/id/versions",
            ),
            (
                super::super::reminders::registry(),
                "reminders/task/id/versions",
            ),
            (
                super::super::health::registry(),
                "health/workout/id/versions",
            ),
            (super::super::photos::registry(), "photos/photo/id/versions"),
        ];
        for (registry, route) in routes {
            let page = registry
                .make(route)
                .unwrap_or_else(|| panic!("route {route}"));
            assert_eq!(page.key(), route);
        }
    }
}
