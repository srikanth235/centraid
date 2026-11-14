//! Outcome and job-boundary coverage shared by Docs and Photos.

use centraid_api_proto::core_v1 as wire;
use centraid_core::screens::ScreenCtx;
use prost::Message;

use crate::kit::original::{
    answered, failure_sentence, landed, no_answer, settle, start, valid_hash,
};
use crate::screen::{Ctx, Environment};
use crate::strings::Locale;

fn encoded(outcome: i32) -> Vec<u8> {
    wire::Response {
        kind: Some(wire::response::Kind::FetchOriginal(
            wire::FetchOriginalResponse {
                outcome,
                path: "/public-test/original.txt".to_owned(),
            },
        )),
    }
    .encode_to_vec()
}

fn done(called: wire::VaultCalled) -> wire::OffThreadDone {
    wire::OffThreadDone {
        tag: format!("original.fetch:{}", "ab".repeat(32)),
        bytes: called.encode_to_vec(),
    }
}

#[test]
fn every_typed_outcome_keeps_its_remedy_and_only_success_settles() {
    use wire::FetchOutcome as O;
    for (outcome, sentence) in [
        (O::Landed, ""),
        (O::AlreadyHeld, ""),
        (
            O::NotInBackup,
            "Your backup device doesn't hold this original.",
        ),
        (O::Untrusted, "That isn't your backup device."),
        (
            O::Damaged,
            "Couldn't open the backup copy of this original.",
        ),
        (
            O::Unreachable,
            "Can't reach your backup device. Try again later.",
        ),
        (
            O::Unspecified,
            "Can't reach your backup device. Try again later.",
        ),
    ] {
        let fetched = answered(&done(wire::VaultCalled {
            response: encoded(outcome as i32),
            error: None,
        }))
        .expect("an original-fetch job");
        assert_eq!(fetched.content_hash, "ab".repeat(32));
        assert_eq!(fetched.outcome, Some(outcome));
        assert_eq!(landed(outcome), sentence.is_empty());
        assert_eq!(failure_sentence(Locale::En, outcome), sentence);
        assert_eq!(
            settle(Locale::En, &fetched),
            if sentence.is_empty() {
                Ok(())
            } else {
                Err(sentence.to_owned())
            }
        );
    }
    let future = answered(&done(wire::VaultCalled {
        response: encoded(999),
        error: None,
    }))
    .expect("a future core outcome is still this job's answer");
    assert_eq!(future.outcome, Some(O::Unspecified));
    assert_eq!(
        settle(Locale::En, &future),
        Err("Can't reach your backup device. Try again later.".to_owned())
    );
}

#[test]
fn damaged_wrong_or_refused_answers_fail_closed_and_unrelated_jobs_are_ignored() {
    let mut malformed_outer = done(wire::VaultCalled::default());
    malformed_outer.bytes = vec![0x80];
    let wrong_response = wire::Response {
        kind: Some(wire::response::Kind::Pins(wire::PinsResponse::default())),
    };
    for event in [
        malformed_outer,
        done(wire::VaultCalled {
            response: vec![0x80],
            error: None,
        }),
        done(wire::VaultCalled::default()),
        done(wire::VaultCalled {
            response: wrong_response.encode_to_vec(),
            error: None,
        }),
        done(wire::VaultCalled {
            response: encoded(wire::FetchOutcome::Landed as i32),
            error: Some(wire::Error::default()),
        }),
    ] {
        let fetched = answered(&event).expect("a failed original-fetch job still terminates");
        assert_eq!(fetched.outcome, None);
        assert_eq!(
            settle(Locale::En, &fetched),
            Err("Couldn't get the original back. Try again.".to_owned())
        );
    }
    assert_eq!(
        no_answer(Locale::En),
        "Couldn't get the original back. Try again."
    );
    for tag in ["", "original.fetch-other:ab", "share:ab"] {
        let mut event = done(wire::VaultCalled {
            response: encoded(wire::FetchOutcome::Landed as i32),
            error: None,
        });
        event.tag = tag.to_owned();
        assert!(
            answered(&event).is_none(),
            "an unrelated job is not consumed"
        );
    }
}

struct NoCore;

impl ScreenCtx for NoCore {
    fn load(&self, _: &wire::LoadRequest) -> centraid_core::Result<wire::LoadResponse> {
        unreachable!("validation reads no core")
    }
    fn act(&self, _: &wire::ActRequest) -> centraid_core::Result<wire::ActResponse> {
        unreachable!("validation writes no core")
    }
    fn push(&self, _: wire::ScreenUpdate) {
        unreachable!("validation pushes no view")
    }
    fn wake_after(&self, _: std::time::Duration) {
        unreachable!("validation starts no timer")
    }
}

#[test]
fn invalid_hashes_queue_no_work_and_a_valid_uppercase_digest_queues_one_job() {
    let host = NoCore;
    let env = Environment::default();
    for hash in [
        String::new(),
        "a".repeat(63),
        "a".repeat(65),
        "x".repeat(64),
        "é".repeat(32),
        format!("{} ", "a".repeat(63)),
    ] {
        assert!(!valid_hash(&hash));
        let ctx = Ctx::new(&host, &env);
        assert!(!start(&ctx, &hash));
        assert!(
            ctx.finish().jobs.is_empty(),
            "an invalid digest never starts a gateway job"
        );
    }
    let hash = "AB".repeat(32);
    assert!(valid_hash(&hash));
    let ctx = Ctx::new(&host, &env);
    assert!(start(&ctx, &hash));
    let jobs = ctx.finish().jobs;
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].0, format!("original.fetch:{hash}"));
}
