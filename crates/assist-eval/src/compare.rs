//! `assist-eval compare A B`: two reports of the same set, paired by session.
//!
//! B is the candidate and A the baseline. A session B passes and A fails is **won**, the other way **lost**; the rest
//! tie. `z = (won - lost) / sqrt(won + lost)`; the owner's rule (HANDOFF.md) is that `|z| < 2` is noise. Counts only,
//! no clocks. Two reports are comparable when they scored the same sessions, with the same tools block and the same
//! grammar; anything else is refused, and so is a report that does not say (a rescore without `--tools`/`--grammar`),
//! because two unknowns are not known to be equal. The adapter and the base model may differ: that is what a
//! comparison is for.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::report::RunConfig;

/// The part of a report a comparison reads (the rest is ignored).
#[derive(Debug, Clone, Deserialize)]
pub struct Comparable {
    pub model: String,
    #[serde(default)]
    pub set: String,
    #[serde(default)]
    pub config: RunConfig,
    #[serde(default)]
    pub verdicts: BTreeMap<String, bool>,
}

impl Comparable {
    /// # Errors
    /// A message naming the file when it cannot be read or is not a report.
    pub fn read(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        serde_json::from_str(&text)
            .map_err(|e| format!("{}: not an assist-eval report: {e}", path.display()))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Comparison {
    pub a: String,
    pub b: String,
    pub sessions: usize,
    pub a_pass: usize,
    pub b_pass: usize,
    /// Sessions B passes and A fails.
    pub won: usize,
    /// Sessions A passes and B fails.
    pub lost: usize,
    pub both_pass: usize,
    pub both_fail: usize,
    pub z: f64,
    /// `|z| < 2`.
    pub noise: bool,
    pub won_ids: Vec<String>,
    pub lost_ids: Vec<String>,
}

fn ids(map: &BTreeMap<String, bool>) -> std::collections::BTreeSet<&str> {
    map.keys().map(String::as_str).collect()
}

fn same_setting(name: &str, a: &Option<String>, b: &Option<String>) -> Result<(), String> {
    match (a, b) {
        (Some(a), Some(b)) if a == b => Ok(()),
        (Some(a), Some(b)) => Err(format!("the reports differ in {name}: {a} and {b}")),
        _ => Err(format!(
            "a report does not say its {name}, so the two cannot be known to be the same (rescore with --{name})"
        )),
    }
}

/// Pair two reports.
///
/// # Errors
/// A message when the reports cannot be compared: no per-session verdicts, a different set of sessions, a different
/// or unknown tools block or grammar.
pub fn compare(a: &Comparable, b: &Comparable) -> Result<Comparison, String> {
    if a.verdicts.is_empty() || b.verdicts.is_empty() {
        return Err(
            "a report has no per-session verdicts (made before `compare` existed): score again"
                .to_owned(),
        );
    }
    if ids(&a.verdicts) != ids(&b.verdicts) {
        let (only_a, only_b): (Vec<&str>, Vec<&str>) = (
            ids(&a.verdicts)
                .difference(&ids(&b.verdicts))
                .copied()
                .collect(),
            ids(&b.verdicts)
                .difference(&ids(&a.verdicts))
                .copied()
                .collect(),
        );
        return Err(format!(
            "the reports scored different sets: {} sessions only in A (first: {:?}), {} only in B (first: {:?})",
            only_a.len(),
            only_a.iter().take(3).collect::<Vec<_>>(),
            only_b.len(),
            only_b.iter().take(3).collect::<Vec<_>>()
        ));
    }
    same_setting("tools", &a.config.tools, &b.config.tools)?;
    same_setting("grammar", &a.config.grammar, &b.config.grammar)?;
    let (mut won_ids, mut lost_ids) = (Vec::new(), Vec::new());
    let (mut both_pass, mut both_fail) = (0, 0);
    for (id, &a_ok) in &a.verdicts {
        match (a_ok, b.verdicts[id]) {
            (false, true) => won_ids.push(id.clone()),
            (true, false) => lost_ids.push(id.clone()),
            (true, true) => both_pass += 1,
            (false, false) => both_fail += 1,
        }
    }
    let (won, lost) = (won_ids.len(), lost_ids.len());
    let z = if won + lost == 0 {
        0.0
    } else {
        (won as f64 - lost as f64) / ((won + lost) as f64).sqrt()
    };
    Ok(Comparison {
        a: a.model.clone(),
        b: b.model.clone(),
        sessions: a.verdicts.len(),
        a_pass: a.verdicts.values().filter(|p| **p).count(),
        b_pass: b.verdicts.values().filter(|p| **p).count(),
        won,
        lost,
        both_pass,
        both_fail,
        z,
        noise: z.abs() < 2.0,
        won_ids,
        lost_ids,
    })
}

impl Comparison {
    /// The text people read.
    #[must_use]
    pub fn text(&self) -> String {
        let verdict = if self.noise {
            "noise (|z| < 2): the owner's rule says this is not a difference"
        } else if self.z > 0.0 {
            "B is better (|z| >= 2)"
        } else {
            "B is worse (|z| >= 2)"
        };
        format!(
            "A (baseline): {}\nB (candidate): {}\n\
             {} sessions paired; A passes {}, B passes {}\n\
             won {} (B passes, A fails)   lost {} (A passes, B fails)   both pass {}   both fail {}\n\
             z = (won - lost) / sqrt(won + lost) = {:.2}: {verdict}\n",
            self.a,
            self.b,
            self.sessions,
            self.a_pass,
            self.b_pass,
            self.won,
            self.lost,
            self.both_pass,
            self.both_fail,
            self.z
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(
        model: &str,
        tools: Option<&str>,
        grammar: Option<&str>,
        passes: &[(&str, bool)],
    ) -> Comparable {
        Comparable {
            model: model.to_owned(),
            set: "set".to_owned(),
            config: RunConfig {
                tools: tools.map(str::to_owned),
                grammar: grammar.map(str::to_owned),
                ..RunConfig::default()
            },
            verdicts: passes
                .iter()
                .map(|(id, p)| ((*id).to_owned(), *p))
                .collect(),
        }
    }

    fn sessions(n: usize, pass: impl Fn(usize) -> bool) -> Vec<(String, bool)> {
        (0..n).map(|i| (format!("S{i:03}"), pass(i))).collect()
    }

    fn with(model: &str, rows: &[(String, bool)]) -> Comparable {
        let rows: Vec<(&str, bool)> = rows.iter().map(|(i, p)| (i.as_str(), *p)).collect();
        report(model, Some("sig"), Some("full"), &rows)
    }

    #[test]
    fn won_lost_and_z_are_counted_per_session() {
        // A passes the first 50; B passes the first 40 and the 30 after them: 30 won, 10 lost
        let a = with("base", &sessions(100, |i| i < 50));
        let b = with(
            "adapter",
            &sessions(100, |i| i < 40 || (50..80).contains(&i)),
        );
        let c = compare(&a, &b).expect("comparable");
        assert_eq!((c.won, c.lost, c.both_pass, c.both_fail), (30, 10, 40, 20));
        assert!((c.z - 20.0 / 40_f64.sqrt()).abs() < 1e-12);
        assert!(!c.noise);
        assert_eq!(c.lost_ids.first().map(String::as_str), Some("S040"));
        assert!(c.text().contains("B is better"));
    }

    #[test]
    fn a_small_difference_is_noise_and_no_difference_is_zero() {
        let a = with("a", &sessions(100, |i| i % 2 == 0));
        let b = with("b", &sessions(100, |i| i % 2 == 0 || i == 1 || i == 3));
        let c = compare(&a, &b).expect("comparable");
        assert_eq!((c.won, c.lost), (2, 0));
        assert!(c.noise, "z = {}", c.z);
        let same = compare(&a, &a).expect("comparable");
        assert!(same.z == 0.0 && same.noise);
    }

    #[test]
    fn reports_of_different_sets_tools_or_grammar_are_refused() {
        let rows = sessions(10, |_| true);
        let a = with("a", &rows);
        let fewer = with("b", &rows[..9]);
        assert!(compare(&a, &fewer).unwrap_err().contains("different sets"));
        let other_ids: Vec<(String, bool)> =
            rows.iter().map(|(i, p)| (format!("{i}x"), *p)).collect();
        assert!(
            compare(&a, &with("b", &other_ids))
                .unwrap_err()
                .contains("different sets")
        );
        let mut s2 = with("b", &rows);
        s2.config.tools = Some("s2".to_owned());
        assert!(compare(&a, &s2).unwrap_err().contains("tools"));
        let mut off = with("b", &rows);
        off.config.grammar = Some("off".to_owned());
        assert!(compare(&a, &off).unwrap_err().contains("grammar"));
    }

    #[test]
    fn a_report_that_does_not_say_how_it_decoded_is_refused_even_against_itself() {
        let rows: Vec<(&str, bool)> = vec![("S1", true), ("S2", false)];
        let unknown = report("a", None, None, &rows);
        assert!(
            compare(&unknown, &unknown)
                .unwrap_err()
                .contains("does not say")
        );
        let empty = report("a", Some("sig"), Some("full"), &[]);
        assert!(
            compare(&empty, &empty)
                .unwrap_err()
                .contains("no per-session verdicts")
        );
    }
}
