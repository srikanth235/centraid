//! HIGHLIGHTS (#1173): what moved most in the last 30 days against the 30 before, said in a
//! sentence ("Over the last 30 days you walked 12% more than the 30 days before."). The
//! percentage is the core's (`HealthTodayMetric.month_change_pct`, the same figure Trends'
//! 30-day range gives); this only chooses which to say and words it.
//!
//! A highlight needs a move of at least [`MIN_PCT`] percent, at most [`MAX`] are said, and the
//! largest move comes first (ties keep Today's metric order). Weight is never one: it is not a
//! thing to praise or scold, and the member reads it on its own page. Nothing is said when
//! nothing moved enough, and the heading goes with it.

use centraid_api_proto::core_v1 as wire;

use super::{Metric, figures, routes};
use crate::strings::{Locale, fill, health as words};

/// The least move, in whole percent, worth a sentence.
pub const MIN_PCT: i64 = 5;
/// The most sentences.
pub const MAX: usize = 2;

/// The metrics and their moves that earn a sentence, largest first.
#[must_use]
pub fn pick(metrics: &[wire::HealthTodayMetric]) -> Vec<(Metric, f64)> {
    let mut chosen: Vec<(Metric, f64)> = Metric::ALL
        .into_iter()
        .filter(|metric| *metric != Metric::Weight)
        .filter_map(|metric| {
            let answer = metrics
                .iter()
                .find(|answer| Metric::of_wire(answer.metric) == Some(metric))?;
            let pct = answer.month_change_pct?;
            (figures::round(pct.abs()) >= MIN_PCT).then_some((metric, pct))
        })
        .collect();
    // A stable sort: equal moves stay in Today's order.
    chosen.sort_by(|a, b| b.1.abs().total_cmp(&a.1.abs()));
    chosen.truncate(MAX);
    chosen
}

fn sentence(locale: Locale, metric: Metric, pct: f64) -> String {
    let up = pct > 0.0;
    let template = match (metric, up) {
        (Metric::Steps, true) => words::highlight_steps_more(locale),
        (Metric::Steps, false) => words::highlight_steps_less(locale),
        (Metric::Sleep, true) => words::highlight_sleep_more(locale),
        (Metric::Sleep, false) => words::highlight_sleep_less(locale),
        (Metric::Energy, true) => words::highlight_energy_more(locale),
        (Metric::Energy, false) => words::highlight_energy_less(locale),
        (Metric::Exercise, true) => words::highlight_exercise_more(locale),
        (Metric::Exercise, false) => words::highlight_exercise_less(locale),
        (_, true) => words::highlight_heart_up(locale),
        (_, false) => words::highlight_heart_down(locale),
    };
    fill(
        &template,
        &[("pct", &format!("{}%", figures::round(pct.abs())))],
    )
}

/// The sentence cut around its bold words: `**` opens and closes them.
fn parts(sentence: &str) -> (String, String, String) {
    let plain = || (sentence.replace("**", ""), String::new(), String::new());
    let Some((lead, rest)) = sentence.split_once("**") else {
        return plain();
    };
    let Some((strong, tail)) = rest.split_once("**") else {
        return plain();
    };
    (lead.to_owned(), strong.to_owned(), tail.to_owned())
}

/// The Summary's highlights; `parent` is the page a tap's metric page returns to.
#[must_use]
pub fn lines(
    locale: Locale,
    metrics: &[wire::HealthTodayMetric],
    parent: &str,
) -> Vec<wire::HealthHighlight> {
    pick(metrics)
        .into_iter()
        .map(|(metric, pct)| {
            let said = sentence(locale, metric, pct);
            let (lead, emphasis, tail) = parts(&said);
            wire::HealthHighlight {
                metric: metric.key().to_owned(),
                lead,
                emphasis,
                tail,
                accessibility_label: said.replace("**", ""),
                route: Some(routes::metric(metric.key(), parent)),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const EN: Locale = Locale::En;

    fn moved(metric: Metric, pct: Option<f64>) -> wire::HealthTodayMetric {
        wire::HealthTodayMetric {
            metric: metric.wire() as i32,
            month_change_pct: pct,
            ..Default::default()
        }
    }

    #[test]
    fn the_biggest_moves_are_said_largest_first_and_at_most_two() {
        let metrics = [
            moved(Metric::Steps, Some(12.4)),
            moved(Metric::Sleep, Some(-7.0)),
            moved(Metric::Energy, Some(-30.0)),
            moved(Metric::Exercise, Some(6.0)),
        ];
        let picked: Vec<(Metric, f64)> = pick(&metrics);
        assert_eq!(picked.len(), MAX);
        assert_eq!(picked[0].0, Metric::Energy);
        assert_eq!(picked[1].0, Metric::Steps);
    }

    #[test]
    fn a_small_move_a_missing_one_and_weight_are_never_said() {
        let metrics = [
            moved(Metric::Steps, Some(4.4)),
            moved(Metric::Sleep, None),
            moved(Metric::Weight, Some(40.0)),
            moved(Metric::RestingHr, Some(-4.4)),
        ];
        assert!(pick(&metrics).is_empty());
        assert!(lines(EN, &metrics, "Summary").is_empty());
        // 4.5 rounds to 5, which is enough; the threshold is on the whole percent that is said.
        assert_eq!(pick(&[moved(Metric::Steps, Some(4.6))]).len(), 1);
    }

    #[test]
    fn equal_moves_keep_todays_order() {
        let metrics = [
            moved(Metric::Exercise, Some(10.0)),
            moved(Metric::Sleep, Some(-10.0)),
            moved(Metric::Steps, Some(10.0)),
        ];
        let order: Vec<Metric> = pick(&metrics)
            .into_iter()
            .map(|(metric, _)| metric)
            .collect();
        assert_eq!(order, [Metric::Steps, Metric::Sleep]);
    }

    #[test]
    fn the_sentence_is_cut_around_its_bold_words_and_reads_whole_aloud() {
        let line = &lines(EN, &[moved(Metric::Steps, Some(12.4))], "Summary")[0];
        assert_eq!(line.lead, "Over the last 30 days you walked ");
        assert_eq!(line.emphasis, "12% more");
        assert_eq!(line.tail, " than the 30 days before.");
        assert_eq!(
            line.accessibility_label,
            "Over the last 30 days you walked 12% more than the 30 days before."
        );
        match &line.route.as_ref().unwrap().args {
            Some(wire::route::Args::HealthMetric(args)) => {
                assert_eq!(
                    (args.metric.as_str(), args.parent.as_str()),
                    ("steps", "Summary")
                );
            }
            other => panic!("not a metric route: {other:?}"),
        }
    }

    #[test]
    fn each_metric_says_its_own_verb_and_a_fall_says_less() {
        let say = |metric: Metric, pct: f64| {
            lines(EN, &[moved(metric, Some(pct))], "")[0]
                .emphasis
                .clone()
        };
        assert_eq!(say(Metric::Sleep, -8.0), "8% less");
        assert_eq!(say(Metric::RestingHr, 6.0), "6% higher");
        assert_eq!(say(Metric::RestingHr, -6.0), "6% lower");
        let energy = &lines(EN, &[moved(Metric::Energy, Some(15.0))], "")[0];
        assert_eq!(energy.tail, " active energy than the 30 days before.");
        let exercise = &lines(EN, &[moved(Metric::Exercise, Some(15.0))], "")[0];
        assert!(exercise.lead.ends_with("you exercised "));
    }
}
