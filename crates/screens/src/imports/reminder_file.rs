//! Bounded RFC 5545 VTODO import. The same reminder model serves a file and EventKit.

use centraid_api_proto::core_v1 as wire;
use centraid_vault::time::{
    recurrence::parse_instant_ms,
    zone::{FireZone, parse_wall_iso},
};

const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_TASKS: usize = 10_000;

fn text(value: &str) -> String {
    let mut out = String::new();
    let mut escaped = false;
    for ch in value.chars() {
        if escaped {
            out.push(if ch == 'n' || ch == 'N' { '\n' } else { ch });
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else {
            out.push(ch);
        }
    }
    out
}

fn date(value: &str) -> Option<(String, String, bool)> {
    let utc = value.ends_with('Z');
    let value = value.trim_end_matches('Z');
    if value.len() != 8 && value.len() != 15 {
        return None;
    }
    if !value.bytes().enumerate().all(|(at, ch)| {
        if at == 8 {
            ch == b'T'
        } else {
            ch.is_ascii_digit()
        }
    }) {
        return None;
    }
    let day = format!("{}-{}-{}", &value[..4], &value[4..6], &value[6..8]);
    let time = if value.len() == 15 {
        format!("{}:{}:{}", &value[9..11], &value[11..13], &value[13..15])
    } else {
        String::new()
    };
    Some((day, time, utc))
}

fn minutes(value: &str) -> Option<i32> {
    let (value, sign) = if let Some(value) = value.strip_prefix("-P") {
        (value, 1_i32)
    } else {
        (
            value.strip_prefix('+').unwrap_or(value).strip_prefix('P')?,
            -1_i32,
        )
    };
    let mut n = 0_i32;
    let mut total = 0_i32;
    for ch in value.chars() {
        if ch.is_ascii_digit() {
            n = n.checked_mul(10)?.checked_add(ch.to_digit(10)? as i32)?;
        } else if ch == 'T' {
            if n != 0 {
                return None;
            }
        } else {
            let factor = match ch {
                'W' => 10_080,
                'D' => 1_440,
                'H' => 60,
                'M' => 1,
                'S' if n == 0 => 0,
                _ => return None,
            };
            total = total.checked_add(n.checked_mul(factor)?)?;
            n = 0;
        }
    }
    (n == 0).then(|| total.checked_mul(sign)).flatten()
}

fn alarm_anchor(day: &str, time: &str, zone: &str, default_zone: &str) -> Option<i64> {
    let time = if time.is_empty() { "00:00:00" } else { time };
    let zone = FireZone::named(if zone.is_empty() { default_zone } else { zone }).ok()?;
    let instant = zone.resolve_wall_time(parse_wall_iso(&format!("{day}T{time}"))?)?;
    parse_instant_ms(&instant.instant)
}

fn property_zone<'a>(parameters: &[&'a str], utc: bool) -> &'a str {
    if utc {
        "UTC"
    } else {
        parameters
            .iter()
            .find_map(|p| p.strip_prefix("TZID="))
            .unwrap_or_default()
            .trim_matches('"')
    }
}

/// A file is text, never code or a remote URL. No property causes I/O.
pub fn parse(
    bytes: &[u8],
    name: &str,
    include_completed: bool,
    default_zone: &str,
) -> Result<wire::RemindersSnapshot, &'static str> {
    if bytes.len() > MAX_BYTES {
        return Err("the task file is too large");
    }
    let source = std::str::from_utf8(bytes).map_err(|_| "the task file is not UTF-8")?;
    let mut lines: Vec<String> = Vec::new();
    for line in source.lines() {
        if let Some(tail) = line.strip_prefix(' ').or_else(|| line.strip_prefix('\t')) {
            let Some(previous) = lines.last_mut() else {
                return Err("the task file starts with a continuation");
            };
            previous.push_str(tail);
        } else {
            lines.push(line.trim_end_matches('\r').to_owned());
        }
    }
    let mut out = wire::RemindersSnapshot {
        device_id: "ical-file".to_owned(),
        ..Default::default()
    };
    let mut list = name
        .trim_end_matches(".ics")
        .trim_end_matches(".ical")
        .to_owned();
    let mut key = String::new();
    let mut task: Option<wire::PhoneReminder> = None;
    let mut alarm = false;
    let mut absolute_alarms = Vec::new();
    let mut relative_alarms: Vec<(i32, bool)> = Vec::new();
    let mut start = None;
    for line in lines {
        let Some((head, value)) = line.split_once(':') else {
            continue;
        };
        let mut parts = head.split(';');
        let property = parts.next().unwrap_or_default().to_ascii_uppercase();
        let parameters: Vec<&str> = parts.collect();
        if property == "BEGIN" && value.eq_ignore_ascii_case("VTODO") {
            if task.is_some() {
                return Err("nested tasks are not valid");
            }
            task = Some(wire::PhoneReminder::default());
            start = None;
            continue;
        }
        if property == "END" && value.eq_ignore_ascii_case("VTODO") {
            let mut item = task.take().ok_or("a task ended before it began")?;
            let due = alarm_anchor(&item.due, &item.time, &item.zone, default_zone);
            for (lead, related_end) in relative_alarms.drain(..) {
                let lead = if !related_end && let Some(start) = start {
                    due.and_then(|due| due.checked_sub(start))
                        .and_then(|delta| (delta % 60_000 == 0).then_some(delta / 60_000))
                        .and_then(|delta| delta.checked_add(i64::from(lead)))
                        .and_then(|n| i32::try_from(n).ok())
                } else {
                    Some(lead)
                };
                if let Some(lead) = lead {
                    item.alarms_before_min.push(lead);
                } else {
                    item.unsupported_alarms += 1;
                }
            }
            for trigger in absolute_alarms.drain(..) {
                let lead = (|| {
                    let delta = due?.checked_sub(trigger)?;
                    if delta % 60_000 != 0 {
                        return None;
                    }
                    i32::try_from(delta / 60_000).ok()
                })();
                if let Some(lead) = lead {
                    item.alarms_before_min.push(lead);
                } else {
                    item.unsupported_alarms += 1;
                }
            }
            if item.phone_id.is_empty() {
                return Err("a task has no UID");
            }
            item.list_key = if key.is_empty() {
                format!("ical:{list}")
            } else {
                format!("ical:{key}")
            };
            item.list_title = list.clone();
            if include_completed || !item.completed {
                out.reminders.push(item);
            }
            if out.reminders.len() > MAX_TASKS {
                return Err("the task file has too many reminders");
            }
            continue;
        }
        let Some(item) = task.as_mut() else {
            match property.as_str() {
                "X-WR-CALNAME" => list = text(value),
                "X-WR-RELCALID" => key = value.to_owned(),
                _ => {}
            }
            continue;
        };
        if property == "BEGIN" && value.eq_ignore_ascii_case("VALARM") {
            alarm = true;
            continue;
        }
        if property == "END" && value.eq_ignore_ascii_case("VALARM") {
            alarm = false;
            continue;
        }
        if alarm {
            if property == "TRIGGER" {
                if let Some(minutes) = minutes(value) {
                    relative_alarms.push((minutes, parameters.contains(&"RELATED=END")));
                } else if let Some((day, time, true)) = date(value)
                    && let Some(instant) = parse_instant_ms(&format!("{day}T{time}Z"))
                {
                    absolute_alarms.push(instant);
                } else {
                    item.unsupported_alarms += 1;
                }
            }
            continue;
        }
        match property.as_str() {
            "UID" => item.phone_id = format!("uid:{value}"),
            "SUMMARY" => item.title = text(value),
            "DESCRIPTION" => item.notes = text(value),
            "URL" => item.url = value.to_owned(),
            "PRIORITY" => item.priority = value.parse().unwrap_or(0),
            "RRULE" => item.rule = value.to_owned(),
            "STATUS" => item.completed = value.eq_ignore_ascii_case("COMPLETED"),
            "PERCENT-COMPLETE" if value == "100" => item.completed = true,
            "X-APPLE-REMINDER-FLAGGED" => {
                item.flagged = Some(value == "1" || value.eq_ignore_ascii_case("TRUE"))
            }
            "RELATED-TO"
                if !parameters
                    .iter()
                    .any(|p| p.starts_with("RELTYPE=") && *p != "RELTYPE=PARENT") =>
            {
                item.parent_phone_id = format!("uid:{value}")
            }
            "DUE" => {
                let (day, time, utc) = date(value).ok_or("a reminder has an invalid due date")?;
                item.due = day;
                item.time = time;
                item.zone = property_zone(&parameters, utc).to_owned();
            }
            "DTSTART" => {
                let (day, time, utc) = date(value).ok_or("a reminder has an invalid start date")?;
                start = alarm_anchor(&day, &time, property_zone(&parameters, utc), default_zone);
            }
            "COMPLETED" => {
                let (day, time, utc) =
                    date(value).ok_or("a reminder has an invalid completion date")?;
                if !utc || time.is_empty() {
                    return Err("completion dates must be UTC instants");
                }
                item.completed_at = format!("{day}T{time}Z");
            }
            _ => {}
        }
    }
    if task.is_some() {
        return Err("a task never ended");
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imports_civil_dst_time_priority_recurrence_flags_parents_url_and_alarms() {
        let file = b"BEGIN:VCALENDAR\r\nX-WR-CALNAME:Travel\r\nBEGIN:VTODO\r\nUID:child\r\nSUMMARY:Book\\, tickets\r\nDESCRIPTION:One\\nTwo\r\n continuation\r\nDUE;TZID=America/New_York:20260308T093000\r\nPRIORITY:1\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nRELATED-TO;RELTYPE=PARENT:parent\r\nX-APPLE-REMINDER-FLAGGED:TRUE\r\nURL:https://example.com\r\nBEGIN:VALARM\r\nTRIGGER:-PT30M\r\nEND:VALARM\r\nEND:VTODO\r\nEND:VCALENDAR";
        let snapshot = parse(file, "tasks.ics", false, "UTC").unwrap();
        let item = &snapshot.reminders[0];
        assert_eq!(
            (&*item.due, &*item.time, &*item.zone),
            ("2026-03-08", "09:30:00", "America/New_York")
        );
        assert_eq!(item.title, "Book, tickets");
        assert_eq!(item.notes, "One\nTwocontinuation");
        assert_eq!(item.parent_phone_id, "uid:parent");
        assert_eq!(item.flagged, Some(true));
        assert_eq!(item.priority, 1);
        assert_eq!(item.alarms_before_min, [30]);
        assert_eq!(item.rule, "FREQ=WEEKLY;COUNT=3");
        assert_eq!(item.url, "https://example.com");
    }
    #[test]
    fn completed_history_is_an_explicit_option_and_malformed_records_are_refused() {
        let file = b"BEGIN:VTODO\nUID:old\nSUMMARY:Done\nSTATUS:COMPLETED\nCOMPLETED:20261104T101500Z\nEND:VTODO";
        assert!(
            parse(file, "tasks.ics", false, "UTC")
                .unwrap()
                .reminders
                .is_empty()
        );
        assert_eq!(
            parse(file, "tasks.ics", true, "UTC").unwrap().reminders[0].completed_at,
            "2026-11-04T10:15:00Z"
        );
        assert!(
            parse(
                b"BEGIN:VTODO\nSUMMARY:No identity\nEND:VTODO",
                "tasks.ics",
                true,
                "UTC"
            )
            .is_err()
        );
    }

    #[test]
    fn alarms_before_after_and_at_absolute_instants_are_kept_across_dst() {
        let file = b"BEGIN:VTODO\nUID:alarms\nSUMMARY:Call\nDUE;TZID=America/New_York:20260308T093000\nBEGIN:VALARM\nTRIGGER:-PT30M\nEND:VALARM\nBEGIN:VALARM\nTRIGGER:PT10M\nEND:VALARM\nBEGIN:VALARM\nTRIGGER;VALUE=DATE-TIME:20260308T131500Z\nEND:VALARM\nEND:VTODO";
        let snapshot = parse(file, "tasks.ics", true, "UTC").unwrap();
        assert_eq!(snapshot.reminders[0].alarms_before_min, [30, -10, 15]);
        assert_eq!(snapshot.reminders[0].unsupported_alarms, 0);
    }

    #[test]
    fn a_start_relative_alarm_is_translated_to_the_tasks_due_anchor() {
        let file = b"BEGIN:VTODO\nUID:window\nSUMMARY:Work\nDTSTART:20261105T090000Z\nDUE:20261105T110000Z\nBEGIN:VALARM\nTRIGGER:-PT15M\nEND:VALARM\nBEGIN:VALARM\nTRIGGER;RELATED=END:PT10M\nEND:VALARM\nEND:VTODO";
        let snapshot = parse(file, "tasks.ics", true, "UTC").unwrap();
        assert_eq!(snapshot.reminders[0].alarms_before_min, [135, -10]);
    }
}
