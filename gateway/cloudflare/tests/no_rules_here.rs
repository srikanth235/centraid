//! NO RULE IS REIMPLEMENTED IN THIS ADAPTER, AS A SCAN (#1029 §3).
//!
//! The architecture's whole point is that `crates/gateway-core` holds every rule
//! once and both adapters reach them: two adapters that each carry half a rule
//! are two adapters that will disagree about it, on a phone somebody is
//! restoring. That is stated in this crate's README and in its `lib.rs`, and a
//! statement is not a check.
//!
//! **A claim names its grep, and this file is the grep.** It is the same file
//! `crates/gateway-server/tests/no_rules_here.rs` is, asked of the other
//! adapter — because a rule that covers one of two adapters is a rule the other
//! is exempt from by accident.
//!
//! What it cannot catch is a rule reimplemented in different words, and that is
//! the conformance suite's job — this catches the easy half loudly so the hard
//! half is the only thing review has to look for.
//!
//! # WHY THIS RUNS ON THE HOST WHEN THE CRATE ONLY DEPLOYS TO wasm32
//!
//! It reads source files as text. That is a deliberate property rather than a
//! compromise: the Worker's own code only builds for `wasm32-unknown-unknown`,
//! and a check that needed the Worker to run would be a check that needs
//! Miniflare, a wasm toolchain and a bucket to tell somebody they restated a
//! constant.

use std::path::{Path, PathBuf};

fn source_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn sources() -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![source_root()];
    while let Some(directory) = stack.pop() {
        for entry in std::fs::read_dir(&directory)
            .expect("the source tree reads")
            .flatten()
        {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                found.push(path);
            }
        }
    }
    found.sort();
    assert!(
        found.len() >= 8,
        "only {} source files were scanned, which is not this crate",
        found.len()
    );
    found
}

fn relative(path: &Path) -> String {
    path.strip_prefix(source_root())
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Scan every non-comment line, calling `judge` with the file, the line number
/// and the line.
fn scan(mut judge: impl FnMut(&str, usize, &str)) {
    for path in sources() {
        let text = std::fs::read_to_string(&path).expect("a source file reads");
        let file = relative(&path);
        for (number, line) in text.lines().enumerate() {
            // A comment that NAMES one of these is explaining why it is absent,
            // which is the opposite of a finding — and most of them do.
            if line.trim_start().starts_with("//") {
                continue;
            }
            judge(&file, number + 1, line);
        }
    }
}

/// ONE PROTOCOL, TWO DEPLOYMENTS, AND NEITHER HALF KNOWS WHICH IT IS.
///
/// `gateway-core` forbids a discriminator among the rules and
/// `gateway-server` forbids one in the standalone adapter. This forbids one
/// here — which is the adapter where the temptation is strongest, because this
/// one really does know it is on Cloudflare.
///
/// What it may know is that its **store** is R2 and its **storage** is a Durable
/// Object. What it may not do is ask "am I the hosted one" and answer a request
/// differently for it.
#[test]
fn this_adapter_never_asks_which_deployment_it_is() {
    const DISCRIMINATORS: [&str; 7] = [
        "GatewayMode",
        "gateway_mode",
        "is_hosted",
        "is_standalone",
        "is_cloudflare",
        "is_worker",
        "deployment_mode",
    ];
    let mut findings = Vec::new();
    scan(|file, number, line| {
        for needle in DISCRIMINATORS {
            if line.contains(needle) {
                findings.push(format!("{file}:{number}: `{needle}`"));
            }
        }
    });
    assert!(
        findings.is_empty(),
        "one protocol, two deployments (#1029 §3). What genuinely differs goes \
         behind `ByteStore`, `StateStore` or `ChecksumMode` — and the one honest \
         difference, admission, is `src/accounts.rs` and ends in the same \
         `VaultState` either way:\n{}",
        findings.join("\n")
    );
}

/// A RULE'S NUMBER LIVES ONCE.
///
/// Each of these is a constant in `centraid-gateway-core`. An adapter that
/// restated one would compile, pass its own tests, and quietly keep a different
/// backup from the other adapter the day somebody tuned it there.
#[test]
fn no_rule_of_the_protocol_is_restated_with_a_literal_here() {
    // `(the literal, what it would be a second copy of)`.
    const RULES: [(&str, &str); 6] = [
        (
            "16 * 1024 * 1024",
            "the object cap — `centraid_gateway_core::upload::MAX_OBJECT_BYTES` (F6)",
        ),
        (
            "shrink_percent",
            "the size guard's threshold — `retention::Policy` (F4)",
        ),
        (
            "daily_for_days",
            "the retention floor — `retention::Policy` (F10)",
        ),
        (
            "base_delete_window",
            "the delete rate limit — `retention::Policy` (F4)",
        ),
        (
            "DEFAULT_REPLAY_WINDOW",
            "the replay window — `auth::DEFAULT_REPLAY_WINDOW`",
        ),
        (
            "RETAIN_AFTER_LAPSE",
            "how long a lapsed plan is kept — `plan::RETAIN_AFTER_LAPSE` (F13)",
        ),
    ];
    let mut findings = Vec::new();
    scan(|file, number, line| {
        for (literal, rule) in RULES {
            // Naming the constant through its own module is reaching for the
            // rule, which is the point. Assigning to it here would be a second
            // copy of it.
            let restated = line.contains(literal)
                && !line.contains("centraid_gateway_core")
                && !line.contains("gateway_core::")
                && !line.contains("auth::")
                && !line.contains("plan::");
            if restated {
                findings.push(format!("{file}:{number}: `{literal}` — {rule}"));
            }
        }
    });
    assert!(
        findings.is_empty(),
        "these lines restate a rule's own number. Reach for the constant in \
         `centraid-gateway-core` instead; a second copy is a rule that drifts \
         the first time somebody tunes one of them:\n{}",
        findings.join("\n")
    );
}

/// ONE HASH, AND THE TWO FILES THAT ARE SOMEBODY ELSE'S PROTOCOL.
///
/// `crates/vault/tests/one_hash.rs` enforces this over the whole Rust tree with
/// an allowlist that now reaches `gateway/` as well. This is the same claim
/// stated locally and in the terms this crate's reader cares about: the boundary
/// is **two files** — one that names R2's own field and one that computes a
/// signature — and a third appearing is the thing to notice.
#[test]
fn the_stores_own_checksum_is_named_in_exactly_two_modules() {
    let mut naming = Vec::new();
    for path in sources() {
        let text = std::fs::read_to_string(&path)
            .expect("a source file reads")
            .to_ascii_lowercase()
            .replace('-', "");
        if text.contains("sha256") {
            naming.push(relative(&path));
        }
    }
    assert_eq!(
        naming,
        vec!["r2.rs".to_owned(), "sigv4.rs".to_owned()],
        "an object's NAME is BLAKE3 everywhere. `r2.rs` NAMES the store's own \
         checksum field and `sigv4.rs` COMPUTES a signature over somebody else's \
         protocol; both carry an entry in `crates/vault/tests/one_hash.rs` with \
         the reason. A third module naming it is a boundary that has started \
         moving (#1025 S4, D-1025-S4-5)"
    );
}

/// THE RULES ARE REACHED, NOT REPLACED.
///
/// The positive half of the same claim: this adapter actually calls
/// `gateway-core`. A scan for what must be absent is satisfied by a crate that
/// does nothing at all, and without this the three tests above would pass
/// against an empty `src/`.
#[test]
fn the_adapter_reaches_the_rules_it_does_not_restate() {
    let mut reaches = std::collections::BTreeSet::new();
    scan(|_, _, line| {
        for reached in [
            // The compare-and-set rule, applied under a Durable Object's
            // single-request execution (F7).
            "commit::compare_and_set",
            // The request signature, assembled once for both adapters — and for
            // the phone, which signs with the same function.
            "auth::verify_request",
            // The version window, in both directions.
            "version::admit",
            // The mailbox's own threshold.
            "mailbox::accept_deposit",
            // Quota and lapse, decided by the gateway's own clock (F13).
            "plan::judge",
            // Which values a refusal carries onto the wire.
            "companions()",
        ] {
            if line.contains(reached) {
                reaches.insert(reached.to_owned());
            }
        }
    });
    assert_eq!(
        reaches.len(),
        6,
        "this adapter should reach every one of these rules rather than \
         reimplementing it; it reaches {reaches:?}"
    );
}

/// THE SQL IS THE SHARED SQL.
///
/// A Durable Object's storage is SQLite, so there is no translation step and
/// nothing to keep in step — which is only true while this crate keeps reading
/// `contracts/gateway/`'s files rather than growing statements of its own. The
/// mailbox's are the one exception and they say why in `src/mailbox.rs`.
#[test]
fn the_shared_statements_are_included_rather_than_restated() {
    let sql = std::fs::read_to_string(source_root().join("sql.rs")).expect("src/sql.rs reads");
    assert!(
        sql.contains("contracts/gateway/queries/"),
        "this adapter's statements must be `contracts/gateway/queries/`'s, by \
         `include_str!`, and not a second copy with the same words in it"
    );
    let mut findings = Vec::new();
    scan(|file, number, line| {
        if file == "mailbox.rs" {
            // Declared and reasoned about in that module: the mailbox tables are
            // in the shared schema and the standalone adapter has no routes over
            // them yet, so a statement with one caller lives beside its caller
            // until there are two.
            return;
        }
        let upper = line.to_ascii_uppercase();
        let writes_sql = ["SELECT ", "INSERT INTO", "UPDATE ", "DELETE FROM"]
            .iter()
            .any(|verb| upper.contains(verb));
        if writes_sql && line.contains('"') {
            findings.push(format!("{file}:{number}: {}", line.trim()));
        }
    });
    assert!(
        findings.is_empty(),
        "SQL lives in `contracts/` and is reached by `include_str!`, so that both \
         adapters run the same statements over the same schema:\n{}",
        findings.join("\n")
    );
}

/// NO PRICE AND NO LICENCE TEXT (Q15, Q16).
///
/// Both are still open with the owner. What this crate builds is the
/// **mechanism** — a receipt maps to an account and an account carries a quota
/// in bytes — and what a product is worth is `PRODUCT_QUOTAS` in the Worker's
/// environment, which the owner sets without a deploy. A number or a plan name
/// compiled in here would be a decision taken by whoever typed it.
#[test]
fn no_price_and_no_licence_text_is_compiled_in() {
    const FORBIDDEN: [&str; 6] = ["USD", "$9", "per month", "per year", "GBP", "EUR"];
    let mut findings = Vec::new();
    for path in sources() {
        let text = std::fs::read_to_string(&path).expect("a source file reads");
        let file = relative(&path);
        for (number, line) in text.lines().enumerate() {
            for needle in FORBIDDEN {
                if line.contains(needle) {
                    findings.push(format!("{file}:{}: `{needle}`", number + 1));
                }
            }
        }
    }
    assert!(
        findings.is_empty(),
        "Q15 (pricing) and Q16 (licensing) are open with the owner. Build the \
         mechanism; encode no price and no licence text:\n{}",
        findings.join("\n")
    );
}
