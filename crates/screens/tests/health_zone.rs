//! Health places "today" in the member's zone, not the UTC day, on both sides of UTC.
//!
//! The vault clock is stopped at a moment where the two days differ: late in the UTC day for a
//! zone ahead of UTC (it is already tomorrow there) and early in the UTC day for a zone behind it
//! (it is still yesterday there). A number recorded for the member's today must be the one every
//! read draws as today: the home's figure, the metric page's last bar, and the window the phone
//! follower reads and writes in. A read that placed the day by UTC fails on one side or both.

mod health_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::health::follow as health;
use centraid_screens::health::routes;
use centraid_screens::kit::civil;
use centraid_screens::strings::Locale;
use health_support::*;

/// `(zone, vault clock in epoch ms, the member's day, the UTC day)`.
const SIDES: [(&str, i64, &str, &str); 2] = [
    // 23:30 UTC on the 10th: 00:30 on the 11th in Berlin.
    (
        "Europe/Berlin",
        1_794_353_400_000,
        "2026-11-11",
        "2026-11-10",
    ),
    // 03:00 UTC on the 11th: 19:00 on the 10th in Los Angeles.
    (
        "America/Los_Angeles",
        1_794_366_000_000,
        "2026-11-10",
        "2026-11-11",
    ),
];

#[test]
fn today_is_the_members_day_not_the_utc_day_on_both_sides_of_utc() {
    for (zone, now_ms, member_day, utc_day) in SIDES {
        let mut d = driver_in("ios", "en-GB", zone, now_ms);
        assert_ne!(member_day, utc_day);
        let today = today_in(&d, zone);
        assert_eq!(today, member_day, "{zone}: the vault clock's day there");
        connect_store(&d);
        record(
            &d,
            &today,
            &[
                (0, "steps", 8_412.0),
                (1, "steps", 7_700.0),
                (2, "steps", 6_100.0),
            ],
        );

        // The home draws the member's day's figure as today's.
        let root = root(&d);
        home_event(
            &mut d,
            root,
            wire::health_home_event::Kind::Refreshed(wire::health_home_event::Refreshed {}),
        );
        let home = home_data(d.view(root));
        let hero = home
            .today_data
            .as_ref()
            .and_then(|data| data.hero.as_ref())
            .expect("Today's hero");
        assert_eq!(hero.value, "8,412", "{zone}: today's steps on Today");

        // The metric page's last bar is that day, and it is the current one.
        let i = push(&mut d, routes::metric("steps", ""));
        let data = match &metric_state(d.view(i)).content {
            Some(wire::health_metric_state::Content::Data(data)) => data.clone(),
            other => panic!("{zone}: the metric has no data: {other:?}"),
        };
        let has: Vec<bool> = data.bars.iter().map(|bar| bar.has_value).collect();
        assert_eq!(
            has,
            [false, false, false, false, true, true, true],
            "{zone}"
        );
        assert!(data.bars.last().unwrap().current, "{zone}");
        assert!(
            data.bars.last().unwrap().callout.ends_with("· 8,412"),
            "{zone}"
        );
        assert_eq!(
            data.caption,
            format!(
                "{} – {}",
                civil::dated(Locale::En, &day_back(member_day, 6)),
                civil::day_month(Locale::En, member_day)
            ),
            "{zone}: the week ends on the member's day"
        );

        // The follower's window is placed in the same zone, so a day the phone states for
        // the member's today is inside it.
        let window = d.with_ctx_in(zone, |ctx| health::window(ctx).expect("the window"));
        assert_eq!(window.today, member_day, "{zone}: the follower's today");
        assert!(window.totals_from.as_str() <= day_back(member_day, 1).as_str());
        let held: Vec<&str> = window
            .held
            .iter()
            .filter(|total| total.metric == "steps")
            .map(|total| total.day.as_str())
            .collect();
        assert!(held.contains(&member_day), "{zone}: {held:?}");
    }
}
