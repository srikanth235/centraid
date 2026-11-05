//! Convert the vault's merge result into native, compare-before-write calendar effects.

use crate::{catalog::act, field::Field, kit::act as kit_act, screen::Ctx};
use centraid_api_proto::core_v1 as wire;
use centraid_vault::time::{recurrence::parse_instant_ms, zone::FireZone};
use serde_json::Value;

pub(super) struct Pending {
    pub change: wire::CalendarMutation,
    origin: String,
    device: String,
    fields: Value,
}

fn wall(value: &str, zone: &str) -> String {
    let Some(ms) = parse_instant_ms(value) else {
        return value.to_owned();
    };
    let Ok(zone) = FireZone::named(zone) else {
        return value.to_owned();
    };
    let w = zone.zoned_parts(ms);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        w.year, w.month, w.day, w.hour, w.minute, w.second
    )
}

pub(super) fn plans(raw: &Value, origin: &str, snapshot: &wire::CalendarSnapshot) -> Vec<Pending> {
    raw.as_array()
        .into_iter()
        .flatten()
        .filter_map(|write| {
            let entity = write["entity_id"].as_str().unwrap_or_default();
            let external = write["external_id"].as_str().unwrap_or_default();
            let original = write["original_start"].as_str().unwrap_or_default();
            let old = snapshot
                .events
                .iter()
                .filter(|event| {
                    (event.phone_id == external
                        || event
                            .series
                            .as_ref()
                            .is_some_and(|series| series.id == external))
                        && (original.is_empty()
                            || super::calendar::key(
                                if event.original_start.is_empty() {
                                    &event.start
                                } else {
                                    &event.original_start
                                },
                                event.series.as_ref().is_some_and(|s| s.start.len() == 10),
                            ) == original)
                })
                .min_by_key(|event| event.moved);
            if !external.is_empty() && old.is_none() {
                return None;
            }
            let mut expected = old.cloned().unwrap_or_default();
            let expected_rule = expected
                .series
                .as_ref()
                .map(|s| s.rrule.clone())
                .unwrap_or_default();
            if let Some(series) = expected.series.as_ref().filter(|_| original.is_empty()) {
                expected.start = series.start.clone();
                expected.end = series.end.clone();
                expected.all_day = series.start.len() == 10;
                expected.tz = series.tz.clone();
                expected.native_id = expected.native_series_id.clone();
            }
            let source = &write["desired"];
            let text = |key: &str| source[key].as_str().unwrap_or_default().to_owned();
            let zone = source["zone"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(&snapshot.device_zone);
            let fields: Vec<String> = write["fields"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            let mut desired = expected.clone();
            desired.title = text("title");
            desired.notes = text("description");
            desired.url = text("url");
            if source.get("location").is_some() {
                desired.location = text("location");
            }
            desired.all_day = text("timing") == "all-day";
            desired.start = if desired.all_day {
                text("starts")
            } else {
                wall(&text("starts"), zone)
            };
            desired.end = if desired.all_day {
                text("ends")
            } else {
                wall(&text("ends"), zone)
            };
            desired.tz = if text("timing") == "floating" {
                String::new()
            } else {
                zone.to_owned()
            };
            desired.free =
                source["busy"].as_i64() == Some(0) || source["busy"].as_bool() == Some(false);
            desired.alarms_before_min = source["reminders"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_i64)
                .filter_map(|n| i32::try_from(n).ok())
                .collect();
            desired.attendees = source["attendees"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|guest| wire::PhoneCalendarAttendee {
                    email: guest["email"].as_str().unwrap_or_default().to_owned(),
                    name: guest["name"].as_str().unwrap_or_default().to_owned(),
                    state: guest["state"].as_str().unwrap_or("needs-action").to_owned(),
                })
                .collect();
            let acknowledged = fields
                .iter()
                .filter_map(|key| source.get(key).map(|value| (key.clone(), value.clone())))
                .collect::<serde_json::Map<_, _>>();
            let calendar_key = origin
                .strip_prefix("calendar:")
                .unwrap_or(origin)
                .to_owned();
            desired.calendar_key = calendar_key.clone();
            Some(Pending {
                change: wire::CalendarMutation {
                    entity_id: entity.to_owned(),
                    calendar_key,
                    native_id: expected.native_id.clone(),
                    deleted: write["deleted"].as_bool().unwrap_or(false),
                    expected: old.map(|_| expected),
                    desired: Some(desired),
                    fields,
                    rule: text("rule"),
                    expected_rule,
                    original_start: original.to_owned(),
                },
                origin: origin.to_owned(),
                device: snapshot.device_id.clone(),
                fields: Value::Object(acknowledged),
            })
        })
        .collect()
}

pub(super) fn acknowledge(ctx: &Ctx, pending: &[Pending], answer: &wire::CalendarWritten) {
    for receipt in &answer.receipts {
        let Some(write) = pending.iter().find(|p| {
            p.change.entity_id == receipt.entity_id
                && p.change.original_start == receipt.original_start
        }) else {
            continue;
        };
        if write.change.deleted || receipt.phone_id.is_empty() || receipt.entity_id.is_empty() {
            continue;
        }
        // A subsequent bounded native read acknowledges the occurrence in the
        // existing source.overrides statement. Its fields are not the master's.
        if !receipt.original_start.is_empty() {
            continue;
        }
        let fields = write
            .fields
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(key, _)| receipt.fields.contains(key))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<serde_json::Map<_, _>>();
        let request = act::agenda::CalendarWritten {
            origin: write.origin.clone(),
            entity_id: receipt.entity_id.clone(),
            external_id: receipt.phone_id.clone(),
            fields: Value::Object(fields).to_string(),
            device_id: if super::calendar::is_portable_id(&receipt.phone_id) {
                Field::Clear
            } else {
                Field::Is(write.device.clone())
            },
        };
        kit_act::act(
            ctx,
            request,
            &kit_act::key(&["calendar-written", &receipt.entity_id], kit_act::fresh()),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn writes_use_the_events_zone_across_dst_instead_of_the_build_hosts_zone() {
        let snapshot = wire::CalendarSnapshot {
            device_zone: "UTC".to_owned(),
            ..Default::default()
        };
        let raw = json!([{"entity_id":"event", "external_id":"", "fields":["starts","ends","timing","zone"], "desired":{"starts":"2026-03-08T13:00:00Z","ends":"2026-03-08T14:00:00Z","timing":"zoned","zone":"America/New_York"}}]);
        let changes = plans(&raw, "calendar:work", &snapshot);
        let desired = changes[0].change.desired.as_ref().unwrap();
        assert_eq!(desired.start, "2026-03-08T09:00:00");
        assert_eq!(desired.end, "2026-03-08T10:00:00");
        assert_eq!(desired.tz, "America/New_York");
    }

    #[test]
    fn occurrence_and_series_plans_keep_distinct_native_targets() {
        let event = |day: &str, native: &str| wire::PhoneCalendarEvent {
            phone_id: "uid:weekly".to_owned(),
            native_id: native.to_owned(),
            native_series_id: "master".to_owned(),
            start: format!("{day}T09:00:00"),
            end: format!("{day}T10:00:00"),
            tz: "America/New_York".to_owned(),
            series: Some(wire::PhoneCalendarSeries {
                id: "uid:weekly".to_owned(),
                rrule: "FREQ=WEEKLY".to_owned(),
                start: "2026-03-02T09:00:00".to_owned(),
                end: "2026-03-02T10:00:00".to_owned(),
                tz: "America/New_York".to_owned(),
            }),
            ..Default::default()
        };
        let snapshot = wire::CalendarSnapshot {
            device_zone: "UTC".to_owned(),
            events: vec![
                event("2026-03-09", "occurrence-1"),
                event("2026-03-16", "occurrence-2"),
            ],
            ..Default::default()
        };
        let mut raw = json!([{"entity_id":"event","external_id":"uid:weekly","original_start":"2026-03-16T09:00:00","fields":["title"],"desired":{"title":"Only this day"}}]);
        let changes = plans(&raw, "calendar:work", &snapshot);
        assert_eq!(changes[0].change.native_id, "occurrence-2");
        assert_eq!(changes[0].change.original_start, "2026-03-16T09:00:00");
        assert_eq!(
            changes[0].change.expected.as_ref().unwrap().start,
            "2026-03-16T09:00:00"
        );
        raw[0]["original_start"] = json!("");
        let changes = plans(&raw, "calendar:work", &snapshot);
        assert_eq!(changes[0].change.native_id, "master");
        assert_eq!(
            changes[0].change.expected.as_ref().unwrap().start,
            "2026-03-02T09:00:00"
        );
    }
}
