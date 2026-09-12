//! `centraid automations` — the client verbs over the fire spine (#1020,
//! D-1020-AU5, D-1020-AU2).
//!
//! ## Each verb is a CLIENT
//!
//! The gateway holds the one writable connection and the scheduler; a CLI that
//! fired an automation itself would be a second scheduler with its own idea of
//! what is due. So these verbs answer questions and hand deliveries over, and
//! the work happens in `centraid_automations`.
//!
//! ## `deliver` is the webhook door (D-1020-AU5)
//!
//! The product has no listening socket, and a webhook is inbound HTTP. The
//! ruling is that a delivery arrives **through a seat**: on desktop that is
//!
//! ```text
//! centraid automations deliver <webhook-id> --secret-file <path> < payload.json
//! ```
//!
//! and from a paired phone it is the gateway's own iroh endpoint, which is a
//! DIALLED connection. A member whose provider can only POST to a URL forwards
//! it from a device they already trust. The feature-gated listener stays
//! recorded as the future option, under the same flag as the HTTPS blob door.
//!
//! **The secret is read from a FILE or from the environment, never from a
//! flag**: an argument is in the shell's history, in `ps`, and in every
//! process-listing screenshot a member ever pastes into a support thread.
//!
//! ## Facts to stderr, JSON to stdout
//!
//! `cmd/mod.rs`'s rule for every verb in this binary. An operator watching a
//! delivery reads stderr; a script reads stdout and gets one JSON document.

use std::io::Read;

use centraid_automations::cron::{self, FireZone};
use centraid_automations::handler::{provenance, recipes};
use centraid_automations::watch;
use centraid_automations::webhook;

use crate::exit;

/// The environment variable a delivery's secret may arrive in.
pub const SECRET_ENV: &str = "CENTRAID_WEBHOOK_SECRET";

/// What `centraid automations` was asked for.
pub enum Args {
    /// The recipe catalogue: what this release ships, at which tier.
    Recipes { json: bool },
    /// What a trigger may watch, and why the rest may not.
    Watchable { json: bool },
    /// The next runs of one expression, in a named zone.
    Next {
        expr: String,
        zone: Option<String>,
        count: usize,
        json: bool,
    },
    /// Hand one inbound delivery to the gateway.
    Deliver {
        webhook_id: String,
        delivery_id: Option<String>,
        secret_file: Option<std::path::PathBuf>,
        json: bool,
    },
}

pub fn run(args: Args) -> u8 {
    match args {
        Args::Recipes { json } => recipes_verb(json),
        Args::Watchable { json } => watchable_verb(json),
        Args::Next {
            expr,
            zone,
            count,
            json,
        } => next_verb(&expr, zone.as_deref(), count, json),
        Args::Deliver {
            webhook_id,
            delivery_id,
            secret_file,
            json,
        } => deliver_verb(
            &webhook_id,
            delivery_id.as_deref(),
            secret_file.as_deref(),
            json,
        ),
    }
}

fn recipes_verb(json: bool) -> u8 {
    let rows: Vec<serde_json::Value> = recipes::CATALOGUE
        .iter()
        .map(|recipe| {
            serde_json::json!({
                "id": recipe.id,
                "ref": recipe.automation_ref(),
                "provenance": recipe.provenance().as_str(),
                "lane": recipe.provenance().lane(None),
                "domain": recipe.domain.as_str(),
                "reads": recipe.content.as_str(),
                "writes": recipe.result_command,
                "also_writes": recipe.also_command,
                "weights": recipe.weights_capability,
                "model": recipe.model_id,
                "reads_enabled_flag": recipe.provenance().reads_enabled_flag(),
            })
        })
        .collect();
    if json {
        print_json(&serde_json::json!({
            "recipes": rows,
            "extraction_only": recipes::EXTRACTION_ONLY_IDS,
            "result_commands": recipes::result_commands(),
            "weights_capabilities": recipes::weights_capabilities(),
        }));
        return exit::OK;
    }
    for recipe in recipes::CATALOGUE {
        println!(
            "{:<12} {:<16} {:<8} reads {:<18} writes {}",
            recipe.id,
            recipe.provenance().as_str(),
            recipe.domain.as_str(),
            recipe.content.as_str(),
            recipe.result_command
        );
    }
    for id in recipes::EXTRACTION_ONLY_IDS {
        println!(
            "{id:<12} {:<16} {:<8} extraction only — no model, no weights",
            provenance(id).as_str(),
            "docs"
        );
    }
    exit::OK
}

fn watchable_verb(json: bool) -> u8 {
    let entities = watch::watchable_entities();
    if json {
        print_json(&serde_json::json!({
            "watchable": entities,
            "rule": "an entity is watchable when the ontology registers it, its band is not \
                     machinery, and its table is not local — so the runtime's own tables are \
                     excluded by absence rather than by a list",
        }));
        return exit::OK;
    }
    eprintln!(
        "{} entities may be watched by a condition or data trigger.",
        entities.len()
    );
    for entity in entities {
        println!("{entity}");
    }
    exit::OK
}

fn next_verb(expr: &str, zone: Option<&str>, count: usize, json: bool) -> u8 {
    if !cron::is_valid(expr) {
        eprintln!("centraid: \"{expr}\" is not a valid 5-field cron expression.");
        return exit::USAGE;
    }
    // THE ZONE IS REQUIRED, and the refusal says why (D-1020-AU2). There is no
    // host-clock tier: a gateway on a server runs in UTC, so a schedule read
    // against it would fire in hours nobody lives in.
    let Some(name) = zone else {
        eprintln!(
            "centraid: name the vault's time zone with --zone — a schedule has no meaning without \
             one, and this machine's own clock is not an answer."
        );
        return exit::USAGE;
    };
    let zone = match FireZone::named(name) {
        Ok(zone) => zone,
        Err(error) => {
            eprintln!("centraid: {error}");
            return exit::USAGE;
        }
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| i64::try_from(since.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default();
    let runs = cron::next_runs(expr, now, &zone, count.max(1));
    if json {
        print_json(&serde_json::json!({
            "expr": expr,
            "zone": zone.name(),
            "runs": runs.iter().map(|at| serde_json::json!({
                "epoch_ms": at,
                "label": cron::run_label(expr, at - 1, &zone, zone.name()),
            })).collect::<Vec<_>>(),
        }));
        return exit::OK;
    }
    for at in runs {
        println!("{}", cron::run_label(expr, at - 1, &zone, "UTC"));
    }
    exit::OK
}

fn deliver_verb(
    webhook_id: &str,
    delivery_id: Option<&str>,
    secret_file: Option<&std::path::Path>,
    json: bool,
) -> u8 {
    let secret = match read_secret(secret_file) {
        Ok(secret) => secret,
        Err(message) => {
            eprintln!("centraid: {message}");
            return exit::USAGE;
        }
    };
    let mut body = String::new();
    // BOUNDED: the ceiling is the ingress door's own, checked before the read
    // finishes rather than after a member's disk fills.
    let read = std::io::stdin()
        .take((webhook::MAX_BODY_BYTES + 1) as u64)
        .read_to_string(&mut body);
    if let Err(error) = read {
        eprintln!("centraid: the payload could not be read: {error}");
        return exit::USAGE;
    }
    if body.len() > webhook::MAX_BODY_BYTES {
        eprintln!(
            "centraid: this payload is over the {} byte ceiling a webhook delivery carries.",
            webhook::MAX_BODY_BYTES
        );
        return exit::REFUSED;
    }
    let delivery = webhook::Delivery {
        webhook_id: webhook_id.to_owned(),
        // A delivery id is per-delivery BY CONTRACT. When the forwarding seat
        // has one (a provider's own header) it passes it through; when it does
        // not, the hash of the payload plus the clock is the honest stand-in —
        // two identical payloads at the same millisecond ARE one delivery.
        delivery_id: delivery_id
            .map_or_else(|| derived_delivery_id(webhook_id, &body), str::to_owned),
        received_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| i64::try_from(since.as_millis()).unwrap_or(i64::MAX))
            .unwrap_or_default(),
        body,
    };
    // The gateway is what stores and fires. This verb's job ends at handing the
    // delivery over, and the gateway rail for it lands with the scheduler host
    // (named in the lane's receipt as the one hand-off this verb waits on).
    eprintln!(
        "centraid: `automations deliver` needs a running gateway to hand \"{}\" to — the \
         scheduler host is the hand-off this verb waits on (#1020).",
        delivery.webhook_id
    );
    if json {
        print_json(&serde_json::json!({
            "webhook_id": delivery.webhook_id,
            "delivery_id": delivery.delivery_id,
            "bytes": delivery.body.len(),
            "secret_present": !secret.is_empty(),
            "accepted": false,
            "reason": "no gateway",
        }));
    }
    exit::NOT_YET_AVAILABLE
}

/// The secret, from a file or the environment. **Never from an argument.**
fn read_secret(secret_file: Option<&std::path::Path>) -> Result<String, String> {
    if let Some(path) = secret_file {
        let text = std::fs::read_to_string(path)
            .map_err(|error| format!("the secret file could not be read: {error}"))?;
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err("the secret file is empty".to_owned());
        }
        return Ok(trimmed.to_owned());
    }
    match std::env::var(SECRET_ENV) {
        Ok(secret) if !secret.trim().is_empty() => Ok(secret.trim().to_owned()),
        _ => Err(format!(
            "give the delivery's secret in --secret-file or {SECRET_ENV} — a secret on the \
             command line is in the shell's history and in every process listing"
        )),
    }
}

/// A delivery id derived from the payload, for a forwarder with no header of
/// its own to pass on.
fn derived_delivery_id(webhook_id: &str, body: &str) -> String {
    let hash = webhook::hash_secret(&format!("{webhook_id}\u{0}{body}"));
    hash[..32].to_owned()
}

fn print_json(value: &serde_json::Value) {
    match serde_json::to_string_pretty(value) {
        Ok(text) => println!("{text}"),
        Err(error) => eprintln!("centraid: the report could not be rendered: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A SECRET IS NEVER AN ARGUMENT. The two accepted sources, and the
    /// sentence that says why.
    #[test]
    fn a_secret_comes_from_a_file_or_the_environment_and_never_from_a_flag() {
        let error = read_secret(None).expect_err("no source");
        assert!(error.contains("process listing"), "{error}");
        assert!(error.contains(SECRET_ENV), "{error}");
        let dir = std::env::temp_dir().join(format!("centraid-secret-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a directory");
        let path = dir.join("secret");
        std::fs::write(&path, "  s3cret\n").expect("written");
        assert_eq!(
            read_secret(Some(&path)).expect("a secret"),
            "s3cret",
            "a trailing newline from `echo` is not part of the secret"
        );
        std::fs::write(&path, "   \n").expect("written");
        assert!(
            read_secret(Some(&path)).is_err(),
            "an empty file is no secret"
        );
        std::fs::remove_dir_all(&dir).ok();
        // And `Args` carries no secret field at all, which is the structural
        // half of the same rule.
        let _ = Args::Deliver {
            webhook_id: "hook1".to_owned(),
            delivery_id: None,
            secret_file: None,
            json: false,
        };
    }

    #[test]
    fn a_derived_delivery_id_is_stable_and_per_payload() {
        let first = derived_delivery_id("hook1", "{\"a\":1}");
        assert_eq!(first.len(), 32);
        assert_eq!(first, derived_delivery_id("hook1", "{\"a\":1}"));
        assert_ne!(first, derived_delivery_id("hook1", "{\"a\":2}"));
        assert_ne!(
            first,
            derived_delivery_id("hook2", "{\"a\":1}"),
            "two routes are two deliveries even at one payload"
        );
    }

    /// EVERY RESULT COMMAND THE CATALOGUE NAMES IS EITHER REGISTERED OR
    /// DECLARED PENDING.
    ///
    /// This crate is the only one that sees both the recipe catalogue and the
    /// command registry, so this is the only place the two can be held
    /// together. A recipe whose command exists in neither list would be a
    /// recognition result with nowhere to go, discovered at fire time.
    #[test]
    fn the_catalogues_result_commands_are_registered_or_named_as_pending() {
        let registry = centraid_vault::commands::Registry::with_system_commands()
            .expect("the system registry builds");
        for command in recipes::result_commands() {
            let registered = registry.get(command).is_some();
            assert_eq!(
                registered,
                !recipes::is_pending(command),
                "{command} is registered={registered} and pending={} — one of the two lists is \
                 wrong",
                recipes::is_pending(command)
            );
        }
        // The one this lane waits on, and the lane that lands it.
        assert_eq!(recipes::pending_commands(), ["core.set_extracted_text"]);
        assert!(registry.get("enrich.upsert_faces").is_some());
        assert!(registry.get("enrich.upsert_embedding").is_some());
        assert!(registry.get("media.set_place_gazetteer").is_some());
    }

    /// The catalogue and the watch list are both readable without a vault,
    /// which is what makes them answerable on a machine that has not been
    /// paired yet.
    #[test]
    fn the_read_only_verbs_need_no_vault() {
        assert_eq!(recipes_verb(true), exit::OK);
        assert_eq!(recipes_verb(false), exit::OK);
        assert_eq!(watchable_verb(true), exit::OK);
    }

    /// THE ZONE IS REQUIRED, and the refusal is a usage error rather than a
    /// silent fallback to this machine's clock.
    #[test]
    fn next_refuses_without_a_zone_and_names_the_reason() {
        assert_eq!(next_verb("0 7 * * *", None, 3, false), exit::USAGE);
        assert_eq!(
            next_verb("0 7 * * *", Some("Mars/Olympus"), 3, false),
            exit::USAGE
        );
        assert_eq!(next_verb("nonsense", Some("UTC"), 3, false), exit::USAGE);
        assert_eq!(
            next_verb("0 7 * * *", Some("Asia/Kolkata"), 3, true),
            exit::OK
        );
        // A count of zero still answers one run rather than nothing: a preview
        // with no rows is a screen that looks broken.
        assert_eq!(next_verb("0 7 * * *", Some("UTC"), 0, false), exit::OK);
    }
}
