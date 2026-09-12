//! ORIGIN MATCHING — one policy, now three implementations and one spec.
//!
//! `apps/extension/src/origin-matching.ts` (the Companion's) and
//! `packages/blueprints/apps/locker/queries/origin-matching.ts` (the app's)
//! are two implementations of one policy with one committed spec between them,
//! and this is the third. The spec is promoted to
//! `contracts/origin-matching-v1.json` **byte-identical** (census §Cross-lane),
//! and [`tests`] runs all of its vectors here while
//! `tests/quality/origin-matching.contract.test.ts` runs the same file through
//! v0's two — so the three answers are one answer or the suite is red
//! (D-1020-L8).
//!
//! ## Why this is in the app crate and not only on the seat
//!
//! v0's app-side copy exists as *defence in depth*: **reveal refuses a
//! wrong-site fill even if a modified client forges `page_origin`*
//! (`queries/origin-matching.ts:1`-`:5`). After wave 4 the fill is
//! seat-mediated — the extension asks the local seat, which unwraps `K`
//! (D-1020-L8, census §E2) — and that makes the check *more* load-bearing, not
//! less: the caller is now a native-messaging host talking to a seat, and the
//! origin it names is the only thing standing between a phishing page and a
//! password.
//!
//! ## The one dependency this file adds, and what it buys (D-1020-L10)
//!
//! "Registrable domain" is not a string operation. v0 asks `tldts` with
//! `allowPrivateDomains: true`, i.e. the Public Suffix List **including**
//! private suffixes, so `accounts.example.co.uk` and `shop.example.co.uk` are
//! one identity while `one.co.uk` and `two.co.uk` are two. Three options were
//! considered:
//!
//! - **(a) a hand-written suffix table.** Rejected: the vectors need `.com`,
//!   `.co.uk`, `.test` and `.example` today, and a table that covers the
//!   fixture is a table fitted to the fixture. A wrong answer here is
//!   permissive in exactly one direction — a credential handed to a different
//!   registrable domain.
//! - **(b) fall back to exact-host wherever the suffix is undecidable.**
//!   Fail-closed and therefore tempting, but it fails the policy's own first
//!   vector: `login.example.com` must match `www.example.com`, and under a
//!   fallback it would not. A policy that silently degrades to a stricter one
//!   is a fill that stops working, which members fix by turning the feature
//!   off.
//! - **(c) the list, embedded and pinned** — `psl`, whose version number *is*
//!   the list's date, the same shape `tldts` has on the TypeScript side.
//!
//! **Adopted (c).** The freshness cost is real and is stated rather than
//! hidden: a suffix added to the PSL after this pin is a domain whose
//! registrable boundary this build computes one label too wide, so the pin is
//! a **refresh obligation** — bumping it re-runs the spec in both trees, and
//! the owner hand-off in the receipt names the cadence.
//!
//! ## IP addresses and loopback are their own identity
//!
//! `tldts` answers `null` for an IP literal and v0 falls back to the hostname;
//! so does this. And loopback is the development exception, spelled **exactly**
//! as v0 spells it — real IPv4 `127.0.0.0/8` plus literal `localhost`, `::1`
//! and `[::1]`, and nothing that merely *starts* `127.` (`127.foo.bar`) or
//! merely *contains* it (`127.0.0.1.evil.test`). Three of the spec's
//! twenty-four vectors exist for that distinction alone.

use url::{Host, Url};

/// How wide a stored address's identity is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MatchPolicy {
    /// The registrable domain, so a sibling host matches.
    #[default]
    RegistrableDomain,
    /// The host, exactly.
    ExactHost,
}

impl MatchPolicy {
    /// The column's spelling. `registrable-domain` is the schema default and
    /// **anything unrecognised reads as it**, which is v0's own coercion
    /// (`row.url_match_policy === "exact-host" ? … : "registrable-domain"`).
    #[must_use]
    pub fn of(value: Option<&str>) -> Self {
        if value == Some("exact-host") {
            Self::ExactHost
        } else {
            Self::RegistrableDomain
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RegistrableDomain => "registrable-domain",
            Self::ExactHost => "exact-host",
        }
    }
}

/// True only for real IPv4 loopback (`127.0.0.0/8`) and exact `localhost` /
/// `::1`.
///
/// The three refusals this spells out are each a spec vector:
/// `127.0.0.1.evil.test` is not an IPv4 literal, `127.foo.bar` is not either,
/// and neither is anything else that happens to begin with those four
/// characters. `http://` is only ever accepted for a host this returns `true`
/// for, so a false positive here is a credential filled over plaintext.
#[must_use]
pub fn is_loopback(hostname: &str) -> bool {
    if hostname == "localhost" || hostname == "::1" || hostname == "[::1]" {
        return true;
    }
    let octets: Vec<&str> = hostname.split('.').collect();
    if octets.len() != 4 {
        return false;
    }
    let mut parsed = Vec::with_capacity(4);
    for octet in octets {
        if octet.is_empty() || octet.len() > 3 || !octet.bytes().all(|byte| byte.is_ascii_digit()) {
            return false;
        }
        match octet.parse::<u16>() {
            Ok(value) if value <= 255 => parsed.push(value),
            _ => return false,
        }
    }
    parsed[0] == 127
}

/// A URL this policy is willing to reason about, or nothing.
///
/// `https` always; `http` **only** for loopback. Anything else — `ftp:`,
/// `file:`, a bare `example.com` that is not a URL at all — is not a refusal to
/// match, it is an address with no identity, and the answer is no match.
fn safe_url(raw: &str) -> Option<Url> {
    let url = Url::parse(raw).ok()?;
    match url.scheme() {
        "https" => {}
        "http" => {
            if !is_loopback(url.host_str()?) {
                return None;
            }
        }
        _ => return None,
    }
    // A URL with no host has no identity either (`https:///path`).
    url.host()?;
    Some(url)
}

/// What a URL's identity is under a policy.
///
/// `exact-host` and loopback are the hostname; everything else is the
/// registrable domain, with the hostname as the fallback an IP literal and an
/// unlisted suffix both land on — `tldts`'s `?? url.hostname`.
fn identity(url: &Url, policy: MatchPolicy) -> String {
    let host = url.host().expect("safe_url checked the host");
    let hostname = url.host_str().unwrap_or_default().to_owned();
    if policy == MatchPolicy::ExactHost {
        return hostname;
    }
    match host {
        // An IP literal has no registrable domain, and `tldts` says so by
        // answering `null`. Falling back to the whole literal is what makes
        // `192.0.2.1` and `192.0.2.2` two identities.
        Host::Ipv4(_) | Host::Ipv6(_) => hostname,
        Host::Domain(domain) => {
            if is_loopback(domain) {
                return hostname;
            }
            psl::domain_str(domain).unwrap_or(domain).to_owned()
        }
    }
}

/// A stored address, as the match takes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OriginCandidate {
    pub url: String,
    pub policy: MatchPolicy,
}

impl OriginCandidate {
    #[must_use]
    pub fn new(url: &str, policy: MatchPolicy) -> Self {
        Self {
            url: url.to_owned(),
            policy,
        }
    }
}

/// Does this page get this credential?
///
/// Scheme, port and identity, all three, and **nothing else**: path and query
/// never participate (two spec vectors say so explicitly), because a stored
/// address with a tenant in its query string is still the same login.
#[must_use]
pub fn matches_origin(candidate: &OriginCandidate, page_url: &str) -> bool {
    let (Some(stored), Some(page)) = (safe_url(&candidate.url), safe_url(page_url)) else {
        return false;
    };
    stored.scheme() == page.scheme()
        && stored.port() == page.port()
        && identity(&stored, candidate.policy) == identity(&page, candidate.policy)
}

/// Normalise a page origin for a fill receipt — `scheme://host[:port]`.
///
/// v0 requires `url.origin === raw`, i.e. the caller must have sent an origin
/// and not a URL: a trailing slash, a path or a query makes this `None`. That
/// strictness is the reason the receipt's `origin` field can be read as a fact
/// rather than as whatever the caller happened to pass.
#[must_use]
pub fn page_origin(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let origin = url.origin().ascii_serialization();
    if origin == raw { Some(origin) } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE SPEC, RUN. Every vector of `contracts/origin-matching-v1.json`.
    ///
    /// The file is the extension's, promoted byte-identical; while the v0 tree
    /// exists the same file is run through v0's two implementations by
    /// `tests/quality/origin-matching.contract.test.ts`, so three
    /// implementations answer one question or something is red.
    #[test]
    fn every_vector_of_the_promoted_spec_passes() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join("contracts/origin-matching-v1.json");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("reading {}: {error}", path.display()));
        let spec: serde_json::Value = serde_json::from_str(&text).expect("the spec is JSON");
        assert_eq!(spec["version"], 1);
        let vectors = spec["vectors"].as_array().expect("the spec has vectors");
        assert_eq!(
            vectors.len(),
            24,
            "the vector count moved; re-read the spec"
        );

        let mut failures = Vec::new();
        for vector in vectors {
            let name = vector["name"].as_str().expect("a vector has a name");
            let stored = vector["stored"].as_str().expect("a vector has a stored");
            let page = vector["page"].as_str().expect("a vector has a page");
            let policy = MatchPolicy::of(vector["policy"].as_str());
            let expected = vector["match"].as_bool().expect("a vector has a verdict");
            let actual = matches_origin(&OriginCandidate::new(stored, policy), page);
            if actual != expected {
                failures.push(format!(
                    "  {name}: {stored} × {page} under {} — expected {expected}, got {actual}",
                    policy.as_str()
                ));
            }
        }
        assert!(
            failures.is_empty(),
            "origin matching disagrees with the spec:\n{}",
            failures.join("\n")
        );
    }

    /// The promoted file is the extension's, byte for byte.
    ///
    /// While `apps/extension/spec/origin-matching-v1.json` exists it is the
    /// oracle, and a fixture nobody may edit is a fixture whose two copies must
    /// be one file's worth of bytes (census §Cross-lane: *both lanes read it;
    /// neither edits it without a red*).
    #[test]
    fn the_promoted_spec_is_byte_identical_to_the_extensions() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let promoted =
            std::fs::read(root.join("contracts/origin-matching-v1.json")).expect("the promotion");
        let v0 = std::fs::read(root.join("apps/extension/spec/origin-matching-v1.json"))
            .expect("the extension's spec");
        assert_eq!(
            promoted, v0,
            "contracts/origin-matching-v1.json is not byte-identical to the \
             extension's spec; the promotion is a move, not an edit"
        );
    }

    #[test]
    fn only_real_loopback_is_loopback() {
        for host in ["localhost", "::1", "[::1]", "127.0.0.1", "127.1.2.3"] {
            assert!(is_loopback(host), "{host} is loopback");
        }
        for host in [
            "127.0.0.1.evil.test",
            "127.foo.bar",
            "127.0.0",
            "127.0.0.256",
            "1270.0.0.1",
            "example.com",
            "0127.0.0.1",
            "",
        ] {
            assert!(!is_loopback(host), "{host} is not loopback");
        }
    }

    /// The receipt's `origin` is an origin, not a URL somebody sent.
    #[test]
    fn a_page_origin_is_an_origin_or_nothing() {
        assert_eq!(
            page_origin("https://example.com").as_deref(),
            Some("https://example.com")
        );
        assert_eq!(
            page_origin("https://example.com:8443").as_deref(),
            Some("https://example.com:8443")
        );
        // A trailing slash is a URL, not an origin — v0's `url.origin !== raw`.
        assert_eq!(page_origin("https://example.com/"), None);
        assert_eq!(page_origin("https://example.com/login"), None);
        assert_eq!(page_origin("ftp://example.com"), None);
        assert_eq!(page_origin("example.com"), None);
        assert_eq!(page_origin(""), None);
    }

    /// The permissive direction is the only one that leaks a credential, so the
    /// suffix boundary gets its own assertion beside the spec's.
    #[test]
    fn a_registrable_domain_is_the_suffix_boundary_and_not_two_labels() {
        let under = |stored: &str, page: &str| {
            matches_origin(
                &OriginCandidate::new(stored, MatchPolicy::RegistrableDomain),
                page,
            )
        };
        assert!(under("https://a.example.co.uk", "https://b.example.co.uk"));
        assert!(!under("https://one.co.uk", "https://two.co.uk"));
        // A private suffix counts, which is what `allowPrivateDomains: true`
        // buys: two GitHub Pages sites are two registrable domains.
        assert!(!under("https://one.github.io", "https://two.github.io"));
    }
}
