//! FOLDING NAMED READS INTO A COMPANION ANSWER (#1020 wave 4 lane extension,
//! D-1020-X8, D-1020-X10).
//!
//! A catalogue statement takes **no caller bind** — that is what makes the
//! catalogue a catalogue (D-1020-F11) — so the reads the Companion needs come
//! back whole and are folded here, in the host, which is a local process of the
//! member and holds nothing.
//!
//! Three folds, one per method that reads:
//!
//! | Method | Fold |
//! |---|---|
//! | `modules` | the installed-app set, joined to v0's own module catalogue |
//! | `blocking-count` | four row counts summed, capped where the badge caps |
//! | `locker:candidates` | **the origin filter**, over the promoted spec |
//!
//! ## Why the origin filter is here and not in the extension (D-1020-X8)
//!
//! v0's Companion carries its own copy of the policy — `origin-matching.ts`,
//! with `tldts` and the Public Suffix List bundled into the extension. That is a
//! third implementation of a security policy shipped inside the least trusted
//! process in the chain, and it buys nothing now: the fill's decision is the
//! **seat's** (`crates/seat::locker::fill_grant` matches against the row's own
//! stored policy), so a candidate list the extension filtered differently would
//! only ever show a login that then refuses to fill.
//!
//! So the extension normalises an origin — pure `URL` work, no suffix list —
//! and the policy runs where the answer matters: `crates/apps/locker::origin`,
//! against `contracts/origin-matching-v1.json`, the same 24 vectors the app
//! crate and both v0 implementations answer. One fewer copy of the list, and the
//! copy that is left is the one the key is behind.
//!
//! ## `has_totp` is false for every item, and that is v0's answer
//!
//! `ITEM_COLUMNS` does not carry `otp_seed` **and must not** (census §A8), so
//! nothing in this chain can see whether an item has a one-time code. v0 has the
//! same hole and the same cause — lane Locker's finding: *`autofill-candidates`
//! never reports a one-time code*, because `autofill-candidates.ts:94` reads
//! `row.otp_seed` off a row projected without it. The port reproduces the
//! answer rather than inventing a better one, and Locker's owner hand-off 2 is
//! where the fix belongs (a projected `otp_seed IS NOT NULL`, never the column).

use centraid_apps_locker::origin::OriginCandidate;
use centraid_apps_locker::{MatchPolicy, matches_origin};

use super::methods::Method;

/// v0's module catalogue, verbatim (`apps/extension/src/types.ts:33`–`:40`).
///
/// Which modules the Companion *uses* is its own local preference (#996 R11);
/// what the vault answers is whether the app is installed at all, which is the
/// `unavailable` state.
pub const MODULE_CATALOG: [(&str, &str); 6] = [
    ("locker", "Locker autofill"),
    ("tasks", "Tasks capture"),
    ("notes", "Notes clipper"),
    ("docs", "Docs screenshots"),
    ("agenda", "Agenda quick-add"),
    ("people", "People capture"),
];

/// One page reply as a list of column-keyed row objects.
fn rows(page: &serde_json::Value) -> Vec<serde_json::Map<String, serde_json::Value>> {
    let columns: Vec<&str> = page
        .get("columns")
        .and_then(serde_json::Value::as_array)
        .map(|columns| {
            columns
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect()
        })
        .unwrap_or_default();
    page.get("rows")
        .and_then(serde_json::Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(serde_json::Value::as_array)
                .map(|values| {
                    columns
                        .iter()
                        .zip(values.iter())
                        .map(|(column, value)| ((*column).to_owned(), value.clone()))
                        .collect()
                })
                .collect()
        })
        .unwrap_or_default()
}

fn text(row: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<String> {
    row.get(key)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// Fold the pages a method asked for into its answer frame.
pub fn pages(
    method: Method,
    pages: &[(String, serde_json::Value)],
    message: &serde_json::Value,
) -> serde_json::Value {
    let value = match method {
        Method::Warm => serde_json::json!({ "ok": true }),
        Method::Modules => modules(pages),
        Method::BlockingCount => blocking(pages),
        Method::LockerCandidates => candidates(pages, message),
        // Every other method lowers to something that is not a page; a page
        // reaching here would be a lowering and a fold that disagree.
        _ => serde_json::json!({
            "statements": pages.iter().map(|(name, _)| name.clone()).collect::<Vec<_>>(),
        }),
    };
    serde_json::json!({ "t": "ok", "value": value })
}

/// `modules` — v0's six, each `granted` when the app is installed on this vault
/// and `unavailable` when it is not.
fn modules(pages: &[(String, serde_json::Value)]) -> serde_json::Value {
    let installed: std::collections::BTreeSet<String> = pages
        .iter()
        .flat_map(|(_, page)| rows(page))
        .filter_map(|row| text(&row, "app_id").or_else(|| text(&row, "name")))
        .collect();
    serde_json::Value::Array(
        MODULE_CATALOG
            .iter()
            .map(|(id, name)| {
                serde_json::json!({
                    "id": id,
                    "name": name,
                    "state": if installed.contains(*id) { "granted" } else { "unavailable" },
                })
            })
            .collect(),
    )
}

/// `blocking-count` — v0's four sources summed, and the badge's own cap named.
///
/// `capped` rather than a bigger read: `approvalBadgeText` renders at most `99`
/// (`worker-core.ts:7`–`:10`), so a count past the window is "99+" whatever the
/// real number is, and reading further would answer a number nothing shows.
fn blocking(pages: &[(String, serde_json::Value)]) -> serde_json::Value {
    let mut sources = serde_json::Map::new();
    let mut count = 0_u64;
    let mut capped = false;
    for (statement, page) in pages {
        let found = rows(page).len() as u64;
        count += found;
        capped = capped || page.get("next").is_some_and(|next| !next.is_null());
        sources.insert(
            statement
                .strip_prefix("companion.")
                .unwrap_or(statement)
                .to_owned(),
            serde_json::json!(found),
        );
    }
    serde_json::json!({ "count": count, "capped": capped, "sources": sources })
}

/// `locker:candidates` — the logins whose stored policy admits this page.
fn candidates(
    pages: &[(String, serde_json::Value)],
    message: &serde_json::Value,
) -> serde_json::Value {
    let page_url = message
        .get("pageUrl")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    // AN INELIGIBLE PAGE HAS NO CANDIDATES, and that is not an empty vault.
    // `matches_origin` carries the eligibility rule itself — HTTPS, or a real
    // loopback development origin — so a `file:` or plain-HTTP page matches
    // nothing here without a second copy of that predicate
    // (`crates/apps/locker::origin::safe_url`). The PAGE URL is passed whole,
    // path and query included, because v0 does and because the policy says path
    // and query never participate.
    let matched: Vec<serde_json::Value> = pages
        .iter()
        .flat_map(|(_, page)| rows(page))
        .filter_map(|row| {
            let url = text(&row, "url")?;
            let policy = MatchPolicy::of(text(&row, "url_match_policy").as_deref());
            if !matches_origin(&OriginCandidate::new(&url, policy), page_url) {
                return None;
            }
            let compromised = row
                .get("compromised")
                .and_then(serde_json::Value::as_i64)
                .is_some_and(|flag| flag != 0);
            Some(serde_json::json!({
                "item_id": text(&row, "item_id")?,
                "title": text(&row, "title").unwrap_or_default(),
                "username": text(&row, "username"),
                "url": url,
                "url_match_policy": match policy {
                    MatchPolicy::ExactHost => "exact-host",
                    MatchPolicy::RegistrableDomain => "registrable-domain",
                },
                // FALSE FOR EVERY ITEM, as v0 answers — see the module header.
                "has_totp": false,
                "compromised": compromised,
                "warning": compromised,
            }))
        })
        .collect();
    serde_json::Value::Array(matched)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(columns: &[&str], rows: Vec<Vec<serde_json::Value>>) -> serde_json::Value {
        serde_json::json!({ "t": "page", "columns": columns, "rows": rows })
    }

    /// THE ORIGIN FILTER IS THE PROMOTED SPEC. Every vector in
    /// `contracts/origin-matching-v1.json` is answered through the fold, so the
    /// Companion's candidate list and the seat's fill cannot disagree.
    #[test]
    fn every_spec_vector_is_answered_through_the_fold() {
        #[derive(serde::Deserialize)]
        struct Spec {
            vectors: Vec<Vector>,
        }
        #[derive(serde::Deserialize)]
        struct Vector {
            name: String,
            stored: String,
            page: String,
            policy: String,
            #[serde(rename = "match")]
            matched: bool,
        }
        let spec: Spec = serde_json::from_str(include_str!(
            "../../../../../contracts/origin-matching-v1.json"
        ))
        .expect("the promoted spec parses");
        assert_eq!(spec.vectors.len(), 24, "the spec's own 24 vectors");
        for vector in &spec.vectors {
            let answered = candidates(
                &[(
                    "locker.autofillLogins".to_owned(),
                    page(
                        &[
                            "item_id",
                            "title",
                            "username",
                            "url",
                            "url_match_policy",
                            "compromised",
                        ],
                        vec![vec![
                            serde_json::json!("item-1"),
                            serde_json::json!("A Login"),
                            serde_json::json!("someone"),
                            serde_json::json!(vector.stored),
                            serde_json::json!(vector.policy),
                            serde_json::json!(0),
                        ]],
                    ),
                )],
                &serde_json::json!({ "pageUrl": vector.page }),
            );
            let found = answered.as_array().expect("an array").len();
            assert_eq!(
                found == 1,
                vector.matched,
                "{}: stored {} page {} under {}",
                vector.name,
                vector.stored,
                vector.page,
                vector.policy
            );
        }
    }

    /// A LOGIN WITH NO STORED URL IS NOT A CANDIDATE FOR ANYTHING.
    #[test]
    fn a_login_with_no_url_matches_no_page() {
        let answered = candidates(
            &[(
                "locker.autofillLogins".to_owned(),
                page(
                    &["item_id", "title", "url", "url_match_policy"],
                    vec![vec![
                        serde_json::json!("item-1"),
                        serde_json::json!("A Login"),
                        serde_json::Value::Null,
                        serde_json::json!("registrable-domain"),
                    ]],
                ),
            )],
            &serde_json::json!({ "pageUrl": "https://www.bank.example" }),
        );
        assert_eq!(answered.as_array().expect("an array").len(), 0);
    }

    /// AN INELIGIBLE PAGE GETS NOTHING, and a plain-HTTP page is ineligible.
    #[test]
    fn an_ineligible_page_is_answered_with_no_candidates() {
        for bad in [
            "http://www.bank.example",
            "file:///etc/passwd",
            "about:blank",
            "",
        ] {
            let answered = candidates(
                &[(
                    "locker.autofillLogins".to_owned(),
                    page(
                        &["item_id", "title", "url", "url_match_policy"],
                        vec![vec![
                            serde_json::json!("item-1"),
                            serde_json::json!("A Login"),
                            serde_json::json!("https://www.bank.example"),
                            serde_json::json!("registrable-domain"),
                        ]],
                    ),
                )],
                &serde_json::json!({ "pageUrl": bad }),
            );
            assert_eq!(answered.as_array().expect("an array").len(), 0, "{bad}");
        }
    }

    /// NO SECRET IS ON A CANDIDATE. The projection carries none, and the fold
    /// asserts it rather than trusting it.
    #[test]
    fn a_candidate_carries_no_secret_shaped_field() {
        let answered = candidates(
            &[(
                "locker.autofillLogins".to_owned(),
                page(
                    &["item_id", "title", "username", "url", "url_match_policy"],
                    vec![vec![
                        serde_json::json!("item-1"),
                        serde_json::json!("A Login"),
                        serde_json::json!("someone"),
                        serde_json::json!("https://login.bank.example"),
                        serde_json::json!("registrable-domain"),
                    ]],
                ),
            )],
            &serde_json::json!({ "pageUrl": "https://www.bank.example" }),
        );
        let candidate = &answered.as_array().expect("an array")[0];
        for forbidden in ["password", "otp_seed", "card_number", "cvv", "content"] {
            assert!(
                candidate.get(forbidden).is_none(),
                "a candidate must not carry `{forbidden}`"
            );
        }
        assert_eq!(candidate["has_totp"], false);
    }

    /// THE BADGE COUNTS FOUR SOURCES and names each of them.
    #[test]
    fn the_badge_sums_four_sources_and_reports_them_separately() {
        let one = |name: &str, count: usize| {
            (
                format!("companion.{name}"),
                page(
                    &["a"],
                    (0..count).map(|at| vec![serde_json::json!(at)]).collect(),
                ),
            )
        };
        let folded = blocking(&[
            one("outbox", 2),
            one("connections", 1),
            one("parked", 3),
            one("scopeRequests", 0),
        ]);
        assert_eq!(folded["count"], 6);
        assert_eq!(folded["capped"], false);
        assert_eq!(folded["sources"]["outbox"], 2);
        assert_eq!(folded["sources"]["parked"], 3);
        assert_eq!(folded["sources"]["scopeRequests"], 0);
    }

    /// A WINDOW THAT DID NOT END IS REPORTED AS CAPPED, never as the number.
    #[test]
    fn a_window_with_more_rows_says_so() {
        let mut full = page(
            &["a"],
            (0..100).map(|at| vec![serde_json::json!(at)]).collect(),
        );
        full["next"] = serde_json::json!({ "sort_key": "z", "pk": "z" });
        let folded = blocking(&[("companion.outbox".to_owned(), full)]);
        assert_eq!(folded["count"], 100);
        assert_eq!(folded["capped"], true);
    }

    /// `modules` — an app that is not installed is `unavailable`, not absent.
    #[test]
    fn an_uninstalled_module_is_unavailable_rather_than_missing() {
        let folded = modules(&[(
            "companion.apps".to_owned(),
            page(
                &["app_id", "name"],
                vec![
                    vec![serde_json::json!("locker"), serde_json::json!("Locker")],
                    vec![serde_json::json!("notes"), serde_json::json!("Notes")],
                ],
            ),
        )]);
        let listed = folded.as_array().expect("an array");
        assert_eq!(listed.len(), MODULE_CATALOG.len());
        let state = |id: &str| {
            listed
                .iter()
                .find(|module| module["id"] == id)
                .map(|module| module["state"].as_str().unwrap_or_default().to_owned())
                .expect("in the catalogue")
        };
        assert_eq!(state("locker"), "granted");
        assert_eq!(state("notes"), "granted");
        assert_eq!(state("agenda"), "unavailable");
    }
}
