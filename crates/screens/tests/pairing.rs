//! `pair.laptop` and the rediscovery piece, through the door a shell uses
//! (#1135, lane H2). Ports `PairAndRestoreSpec` (the pairing half) and
//! `GatewayMatchSpec`; the matching law's own cases are unit tests beside it
//! (`pairing/matching.rs`).
//!
//! The core's answer to a pairing is injected as the `OffThreadDone` the
//! runtime would deliver, because a successful pairing needs a gateway; one
//! test lets the real core refuse a code that is not one.

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::custody::secrets::VaultSecrets;
use centraid_screens::pairing::discovery::Rediscovery;
use centraid_screens::pairing::laptop::{ANNOUNCE_PAIRED, ANNOUNCE_REKEY, ticket_of};
use centraid_screens::pairing::{self, routes};
use centraid_screens::testing::Driver;
use centraid_screens::{Ctx, Registry, Runtime, Screen};
use prost::Message;
use wire::pair_laptop_event::Kind as P;
use wire::pair_laptop_state::Phase;
use wire::screen_event::Kind as E;

const NUMBER: &str = "38394 36422 07209 27357 06879 57260 38834 97705 12477 24050 94056 44949";

fn runtime() -> Runtime {
    Runtime::new(
        pairing::registry(&VaultSecrets::new()),
        vec![("pair".to_owned(), routes::laptop())],
    )
}

/// A keyed vault, pairing opened.
fn keyed() -> (Driver, u64) {
    opened(Driver::keyed(runtime()))
}

fn opened(mut driver: Driver) -> (Driver, u64) {
    driver.start();
    let id = driver.navigation.as_ref().unwrap().tabs[0].entries[0].instance;
    (driver, id)
}

fn state(driver: &Driver, id: u64) -> wire::PairLaptopState {
    match &driver.view(id).kind {
        Some(wire::view_state::Kind::PairLaptop(state)) => state.clone(),
        other => panic!("not the pairing screen: {other:?}"),
    }
}

fn event(driver: &mut Driver, id: u64, kind: P) {
    driver.send(
        id,
        E::PairLaptop(wire::PairLaptopEvent { kind: Some(kind) }),
    );
}

fn typed(driver: &mut Driver, id: u64, text: &str) {
    event(
        driver,
        id,
        P::Typed(wire::pair_laptop_event::PayloadTyped {
            text: text.to_owned(),
        }),
    );
}

fn primary(driver: &mut Driver, id: u64) {
    event(driver, id, P::Primary(wire::pair_laptop_event::Primary {}));
}

fn scanned(driver: &mut Driver, id: u64, text: &str) {
    driver.send(
        id,
        E::EffectResult(wire::EffectResult {
            effect_id: 0,
            outcome: Some(wire::effect_result::Outcome::CodeScanned(
                wire::CodeScanned {
                    text: text.to_owned(),
                },
            )),
        }),
    );
}

/// What the runtime delivers when the core answered the pairing.
fn answered(driver: &mut Driver, id: u64, tag: &str, called: wire::VaultCalled) {
    driver.send(
        id,
        E::OffThreadDone(wire::OffThreadDone {
            tag: tag.to_owned(),
            bytes: called.encode_to_vec(),
        }),
    );
}

fn paired_with(label: &str, address: &str, safety: &str) -> wire::VaultCalled {
    wire::VaultCalled {
        response: wire::Response {
            kind: Some(wire::response::Kind::PairPhone(wire::PairResponse {
                safety_number: safety.to_owned(),
                destination: Some(wire::Destination {
                    label: label.to_owned(),
                    addrs: if address.is_empty() {
                        Vec::new()
                    } else {
                        vec![address.to_owned()]
                    },
                    ..Default::default()
                }),
            })),
        }
        .encode_to_vec(),
        error: None,
    }
}

fn refused(code: wire::ErrorCode) -> wire::VaultCalled {
    wire::VaultCalled {
        response: Vec::new(),
        error: Some(wire::Error {
            code: code as i32,
            ..Default::default()
        }),
    }
}

fn announced(driver: &Driver, topic: &str) -> bool {
    driver.effects.iter().any(|request| {
        matches!(
            request.effect.as_ref().and_then(|e| e.kind.as_ref()),
            Some(wire::effect::Kind::Announce(a)) if a.topic == topic
        )
    })
}

/// Typed `eyJ2` and pairing: the screen is waiting on the core.
fn pairing(driver: &mut Driver, id: u64) {
    typed(driver, id, "eyJ2");
    primary(driver, id);
    assert_eq!(state(driver, id).phase, Phase::Pairing as i32);
}

#[test]
fn opening_asks_whether_the_vault_can_pair_a_keyed_one_waits_for_the_code_an_unkeyed_one_needs_its_words()
 {
    let (driver, id) = keyed();
    let ready = state(&driver, id);
    assert_eq!(ready.phase, Phase::Waiting as i32);
    assert_eq!(ready.title, "Pair with your backup device");
    assert_eq!(ready.scan_label, "Scan QR code");
    assert_eq!(ready.payload_label, "Pairing code");
    assert_eq!(ready.secondary_label, "Cancel");
    assert!(!ready.primary_enabled);

    let (driver, id) = opened(Driver::with_runtime(runtime()));
    let words = state(&driver, id);
    assert_eq!(words.phase, Phase::NeedsWords as i32);
    assert_eq!(
        words.notice,
        "This vault is open without your recovery key. Enter it, then pair."
    );
    assert_eq!(words.title, "Enter your recovery key first");

    let (driver, id) = opened(Driver::unfounded(runtime()));
    let none = state(&driver, id);
    assert_eq!(none.phase, Phase::NeedsWords as i32);
    assert_eq!(
        none.notice,
        "Make a vault on this phone first, then pair it with your backup device."
    );
    // No vault keeps the screen's own title over its one sentence.
    assert_eq!(none.title, "Pair with your backup device");
}

#[test]
fn a_vault_that_opened_without_its_words_is_offered_them_back_and_the_tap_finishes_the_pairing() {
    // LOCKER'S WALL HAS THE SAME DOOR (#1047 E1): the label is the state's, so
    // the view draws a control only where Rust put one.
    let (mut driver, id) = opened(Driver::with_runtime(runtime()));
    let needs = state(&driver, id);
    assert_eq!(needs.words_label, "Enter your recovery key");
    assert_eq!(needs.primary_label, "Done");
    event(
        &mut driver,
        id,
        P::Words(wire::pair_laptop_event::WordsTapped {}),
    );
    assert!(state(&driver, id).finished);
    assert!(announced(&driver, ANNOUNCE_REKEY));

    // NO VAULT, NO WORDS TO ENTER: no door, and a stray tap changes nothing.
    let (mut driver, id) = opened(Driver::unfounded(runtime()));
    assert_eq!(state(&driver, id).words_label, "");
    event(
        &mut driver,
        id,
        P::Words(wire::pair_laptop_event::WordsTapped {}),
    );
    assert!(!state(&driver, id).finished);
    assert!(!announced(&driver, ANNOUNCE_REKEY));

    // Nor anywhere else the door is not drawn.
    let (mut driver, id) = keyed();
    assert_eq!(state(&driver, id).words_label, "");
    event(
        &mut driver,
        id,
        P::Words(wire::pair_laptop_event::WordsTapped {}),
    );
    assert_eq!(state(&driver, id).phase, Phase::Waiting as i32);
    assert!(!state(&driver, id).finished);
}

#[test]
fn scan_asks_the_shell_to_read_a_code_and_a_code_read_pairs_at_once() {
    let (mut driver, id) = keyed();
    event(
        &mut driver,
        id,
        P::Scan(wire::pair_laptop_event::ScanTapped {}),
    );
    let asked = driver.effects.remove(0);
    // The camera screen's "choose a photo" control is worded here.
    match asked.effect.and_then(|e| e.kind) {
        Some(wire::effect::Kind::ScanCode(scan)) => assert_eq!(scan.photo_label, "Choose a photo"),
        other => panic!("not a scan: {other:?}"),
    }
    // The machine moves only on what comes back.
    assert_eq!(state(&driver, id).phase, Phase::Waiting as i32);

    scanned(&mut driver, id, "eyJ2IjoyfQ");
    let pairing = state(&driver, id);
    assert_eq!(pairing.phase, Phase::Pairing as i32);
    assert_eq!(pairing.progress, "Pairing with your backup device…");
    // The field is not drawn while the core works.
    assert_eq!(pairing.payload_label, "");
    assert_eq!(pairing.scan_label, "");

    // A scan the member backs out of sends nothing at all, and Scan asks
    // nothing where there is no field (NEEDS_WORDS).
    let (mut driver, id) = opened(Driver::with_runtime(runtime()));
    event(
        &mut driver,
        id,
        P::Scan(wire::pair_laptop_event::ScanTapped {}),
    );
    assert!(driver.effects.is_empty());
}

#[test]
fn a_photo_with_no_square_in_it_says_so_and_keeps_the_field_nothing_is_spent() {
    let (mut driver, id) = keyed();
    typed(&mut driver, id, "half a code");
    scanned(&mut driver, id, "");
    let unread = state(&driver, id);
    assert_eq!(unread.phase, Phase::Waiting as i32);
    assert_eq!(
        unread.notice,
        "No readable QR code in that photo. Choose a sharper one, or paste the pairing code."
    );
    assert_eq!(unread.payload, "half a code");
    assert_eq!(unread.scan_label, "Scan QR code");

    // Typing again clears the sentence, as it clears every other one.
    typed(&mut driver, id, "half a code.");
    assert_eq!(state(&driver, id).notice, "");

    // Heard only while the field is drawn.
    pairing(&mut driver, id);
    scanned(&mut driver, id, "");
    assert_eq!(state(&driver, id).phase, Phase::Pairing as i32);
    assert_eq!(state(&driver, id).notice, "");
}

#[test]
fn the_code_is_trimmed_the_terminals_pair_label_is_dropped_and_nothing_else_is_judged_here() {
    // THE CORE OWNS THE PAYLOAD'S SHAPE. A screen that validated it would be a
    // second parser for a format it does not own.
    assert_eq!(ticket_of("  eyJ2IjoxfQ  "), "eyJ2IjoxfQ");
    assert_eq!(ticket_of("pair      eyJ2IjoxfQ\n"), "eyJ2IjoxfQ");
    assert_eq!(
        ticket_of("pairing-is-not-a-label"),
        "pairing-is-not-a-label"
    );
    assert_eq!(ticket_of("pair"), "pair");

    // The core reads what was sent, not what was typed: "pair abc" reaches it
    // as "abc", which is not a code, and the real core says so.
    let (mut driver, id) = keyed();
    typed(&mut driver, id, "pair  abc");
    primary(&mut driver, id);
    assert_eq!(state(&driver, id).phase, Phase::Pairing as i32);
    driver.pump(Duration::from_secs(10));
    let failed = state(&driver, id);
    assert_eq!(failed.phase, Phase::Failed as i32);
    assert_eq!(
        failed.notice,
        "That code didn't work. Run “centraid-gateway pair” again for a new one."
    );
}

#[test]
fn an_empty_box_is_answered_here_because_there_is_nothing_to_send() {
    let (mut driver, id) = keyed();
    typed(&mut driver, id, "   ");
    // The primary is off while the box holds nothing; a tap that arrives anyway
    // is answered with the sentence.
    assert!(!state(&driver, id).primary_enabled);
    primary(&mut driver, id);
    let step = state(&driver, id);
    assert_eq!(step.phase, Phase::Waiting as i32);
    assert_eq!(step.notice, "Scan the QR code, or paste the pairing code.");
}

#[test]
fn paired_shows_the_safety_number_to_compare_and_names_the_gateway() {
    let (mut driver, id) = keyed();
    pairing(&mut driver, id);
    answered(
        &mut driver,
        id,
        "pair",
        paired_with("Home laptop", "192.168.1.20:7443", NUMBER),
    );
    let paired = state(&driver, id);
    assert_eq!(paired.phase, Phase::Paired as i32);
    // THE DIGITS, VERBATIM — every group, as the gateway prints them.
    assert_eq!(paired.safety_number, NUMBER);
    // v2 CARRIES NO HEX ID TO LEAK: the answer is the gateway's own label and
    // the address it was reached at, and the body names both.
    assert!(
        paired
            .body
            .contains("Paired with Home laptop at 192.168.1.20:7443.")
    );
    assert_eq!(paired.payload, "");
    assert_eq!(paired.title, "Check it's your backup device");
    assert_eq!(paired.primary_label, "Done");
    // The Backup screen and the shell's pins are told once.
    assert!(announced(&driver, ANNOUNCE_PAIRED));
    primary(&mut driver, id);
    assert!(state(&driver, id).finished);
}

#[test]
fn a_failed_pairing_announces_nothing_and_a_paired_one_announces_once() {
    let (mut driver, id) = keyed();
    pairing(&mut driver, id);
    answered(
        &mut driver,
        id,
        "pair",
        refused(wire::ErrorCode::Unauthorized),
    );
    assert!(!announced(&driver, ANNOUNCE_PAIRED));
    // THE SAME TEXT, AGAIN.
    primary(&mut driver, id);
    assert_eq!(state(&driver, id).phase, Phase::Pairing as i32);
    answered(&mut driver, id, "pair", paired_with("", "", NUMBER));
    let count = |driver: &Driver| {
        driver
            .effects
            .iter()
            .filter(|request| {
                matches!(
                    request.effect.as_ref().and_then(|e| e.kind.as_ref()),
                    Some(wire::effect::Kind::Announce(a)) if a.topic == ANNOUNCE_PAIRED
                )
            })
            .count()
    };
    assert_eq!(count(&driver), 1);
    // A late second answer is not heard.
    answered(&mut driver, id, "pair", paired_with("", "", NUMBER));
    assert_eq!(count(&driver), 1);
}

#[test]
fn nothing_to_compare_is_a_failure_to_retry_never_a_pairing_shown() {
    // THE COMPARISON IS THE WHOLE SECURITY PROPERTY. A screen asking a member
    // to compare a blank is worse than one that refused.
    let (mut driver, id) = keyed();
    pairing(&mut driver, id);
    answered(&mut driver, id, "pair", paired_with("Home laptop", "", " "));
    let failed = state(&driver, id);
    assert_eq!(failed.phase, Phase::Failed as i32);
    assert_eq!(
        failed.notice,
        "Couldn't verify your backup device, so it didn't pair. Try again."
    );
    assert_eq!(failed.safety_number, "");
    assert!(!announced(&driver, ANNOUNCE_PAIRED));
}

#[test]
fn a_gateway_that_answered_and_refused_is_not_one_that_did_not_answer_each_refusal_says_its_own_remedy()
 {
    // #1047 E5: a spent or unknown pairing code is not "your gateway did not
    // answer", which would send a member to wake a gateway that is awake.
    let again = "That code didn't work. Run “centraid-gateway pair” again for a new one.";
    for (code, sentence) in [
        (wire::ErrorCode::Unauthorized, again),
        (wire::ErrorCode::InvalidRequest, again),
        (
            wire::ErrorCode::PeerUnreachable,
            "No answer from your backup device. Check it's awake and on the same network.",
        ),
        // Anything this build does not name is read as silence.
        (
            wire::ErrorCode::Timeout,
            "No answer from your backup device. Check it's awake and on the same network.",
        ),
        (
            wire::ErrorCode::VaultMoved,
            "This vault moved to your other phone. Restore it with your recovery key to pair here.",
        ),
    ] {
        let (mut driver, id) = keyed();
        pairing(&mut driver, id);
        answered(&mut driver, id, "pair", refused(code));
        let failed = state(&driver, id);
        assert_eq!(failed.phase, Phase::Failed as i32, "{code:?}");
        assert_eq!(failed.notice, sentence, "{code:?}");
        assert_eq!(failed.title, "Not paired");
    }
    // No answer at all, and an answer that is not a pairing, are silence too.
    let (mut driver, id) = keyed();
    pairing(&mut driver, id);
    answered(
        &mut driver,
        id,
        "pair",
        wire::VaultCalled {
            response: Vec::new(),
            error: None,
        },
    );
    assert_eq!(
        state(&driver, id).notice,
        "No answer from your backup device. Check it's awake and on the same network."
    );

    // THE MEMBER CAN PASTE A NEW CODE straight into the failed screen.
    let (mut driver, id) = keyed();
    pairing(&mut driver, id);
    answered(
        &mut driver,
        id,
        "pair",
        refused(wire::ErrorCode::Unauthorized),
    );
    let failed = state(&driver, id);
    assert_eq!(failed.primary_label, "Try again");
    assert_eq!(failed.payload_label, "Pairing code");
    typed(&mut driver, id, "new");
    let waiting = state(&driver, id);
    assert_eq!(waiting.notice, "");
    assert_eq!(waiting.phase, Phase::Waiting as i32);
}

#[test]
fn a_moved_vault_is_refused_with_nothing_to_retry_no_field_no_scan_no_try_again_and_one_done() {
    // THE ACTION THAT CAN SUCCEED, OR NONE (#1080 receipt, "for the owner").
    // `VAULT_MOVED` means another phone holds this vault's writer epoch, so the
    // same pairing and a fresh code are answered the same way.
    let (mut driver, id) = keyed();
    pairing(&mut driver, id);
    answered(
        &mut driver,
        id,
        "pair",
        refused(wire::ErrorCode::VaultMoved),
    );
    let moved = state(&driver, id);
    assert_eq!(moved.phase, Phase::Failed as i32);
    assert_eq!(
        moved.notice,
        "This vault moved to your other phone. Restore it with your recovery key to pair here."
    );
    assert_eq!(moved.primary_label, "Done");
    assert_ne!(moved.primary_label, "Try again");
    assert_eq!(moved.payload_label, "");
    assert_eq!(moved.payload, "");
    assert_eq!(moved.scan_label, "");
    assert_eq!(moved.secondary_label, "");
    assert_eq!(moved.body, "");
    assert!(moved.primary_enabled);

    // NOTHING TYPED OR SCANNED CHANGES IT, and nothing is sent.
    typed(&mut driver, id, "new");
    assert_eq!(state(&driver, id).notice, moved.notice);
    event(
        &mut driver,
        id,
        P::Scan(wire::pair_laptop_event::ScanTapped {}),
    );
    assert!(driver.effects.iter().all(|request| !matches!(
        request.effect.as_ref().and_then(|e| e.kind.as_ref()),
        Some(wire::effect::Kind::ScanCode(_))
    )));
    scanned(&mut driver, id, "eyJ2");
    assert_eq!(state(&driver, id).phase, Phase::Failed as i32);

    // DONE CLOSES, and pairs nothing.
    primary(&mut driver, id);
    assert!(state(&driver, id).finished);

    // A SCREEN OPENED AGAIN STARTS CLEAN: the bar does not outlive the page.
    let (driver, id) = opened(Driver::keyed(runtime()));
    let fresh = state(&driver, id);
    assert_eq!(fresh.phase, Phase::Waiting as i32);
    assert_ne!(fresh.payload_label, "");
}

#[test]
fn cancel_leaves_unless_the_core_is_pairing() {
    let (mut driver, id) = keyed();
    pairing(&mut driver, id);
    event(
        &mut driver,
        id,
        P::Secondary(wire::pair_laptop_event::Secondary {}),
    );
    assert!(
        !state(&driver, id).finished,
        "a pairing in flight is not left"
    );

    let (mut driver, id) = keyed();
    event(
        &mut driver,
        id,
        P::Secondary(wire::pair_laptop_event::Secondary {}),
    );
    assert!(state(&driver, id).finished);
}

#[test]
fn the_screen_opens_by_its_route_from_another_area() {
    let route = routes::laptop();
    assert_eq!(route.screen, "pair.laptop");
    let mut driver = Driver::keyed(Runtime::new(
        pairing::registry(&VaultSecrets::new()),
        vec![("home".to_owned(), routes::laptop())],
    ));
    driver.start();
    // Pushed a second time, as a Backup row's route would be.
    let id = driver.push("home", route);
    assert_eq!(state(&driver, id).phase, Phase::Waiting as i32);
}

// ---- rediscovery -----------------------------------------------------------

/// A screen that follows a paired gateway to its new addresses, as the Backup
/// screen or a pass service would.
struct Follower {
    follow: Rediscovery,
    asked: usize,
    heard: usize,
}

impl Screen for Follower {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => return self.follow.start(),
            Some(E::EffectResult(result)) => {
                if let Some(wire::effect_result::Outcome::GatewaysSighted(sighted)) = result.outcome
                {
                    self.follow.sighted(ctx, &sighted);
                    self.asked = self.follow.pending();
                }
            }
            Some(E::OffThreadDone(done)) => {
                if self.follow.heard(&done) {
                    self.heard += 1;
                }
            }
            Some(E::Left(_)) => return self.follow.stop(),
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        wire::ViewState {
            kind: Some(wire::view_state::Kind::Counter(wire::CounterView {
                title: format!("asked {} heard {}", self.asked, self.heard),
                content: None,
            })),
            ..Default::default()
        }
    }
}

fn follower() -> Driver {
    Driver::with_runtime(Runtime::new(
        Registry::default().with("follower", |_| {
            Some(Box::new(Follower {
                follow: Rediscovery::default(),
                asked: 0,
                heard: 0,
            }) as Box<dyn Screen>)
        }),
        vec![(
            "f".to_owned(),
            wire::Route {
                screen: "follower".to_owned(),
                ..Default::default()
            },
        )],
    ))
}

fn id_of(byte: &str) -> String {
    byte.repeat(32)
}

fn sighting(name: &str, gw: &str, addresses: &[&str]) -> wire::GatewaySighting {
    wire::GatewaySighting {
        service_name: name.to_owned(),
        txt: [("gw".to_owned(), gw.to_owned())].into(),
        addresses: addresses.iter().map(|a| (*a).to_owned()).collect(),
    }
}

fn record(driver: &Driver, gateway_id: &str, addrs: &[&str]) {
    let ledger = centraid_vault::backup::ledger::Ledger::open(
        centraid_vault::backup::ledger::Ledger::path_for(driver.handle.path()),
    )
    .expect("the ledger opens");
    ledger
        .put_destination(&centraid_vault::backup::ledger::Destination {
            gateway_id: gateway_id.to_owned(),
            addrs: addrs.iter().map(|a| (*a).to_owned()).collect(),
            cert_der: vec![1, 2, 3],
            token: "token".to_owned(),
            epoch: 1,
            label: "Home laptop".to_owned(),
            paired_at_ms: 1,
            last_seen_ms: None,
            last_ack_ms: None,
        })
        .expect("the destination is recorded");
}

fn sight(driver: &mut Driver, id: u64, sightings: Vec<wire::GatewaySighting>) {
    driver.send(
        id,
        E::EffectResult(wire::EffectResult {
            effect_id: 0,
            outcome: Some(wire::effect_result::Outcome::GatewaysSighted(
                wire::GatewaysSighted { sightings },
            )),
        }),
    );
}

fn title(driver: &Driver, id: u64) -> String {
    driver.counter(id).title.clone()
}

fn started() -> (Driver, u64) {
    let (driver, id) = opened(follower());
    // The browse is asked for under the screen that wants it.
    let browse = driver.effects.iter().find_map(|request| {
        match request.effect.as_ref().and_then(|e| e.kind.as_ref()) {
            Some(wire::effect::Kind::BrowseGateways(browse)) => Some(*browse),
            _ => None,
        }
    });
    let browse = browse.expect("a browse is asked for");
    assert!(browse.on);
    assert_eq!(browse.window_ms, 4_000);
    assert_eq!(browse.repeat_ms, 30_000);
    (driver, id)
}

#[test]
fn a_rediscovery_offers_the_core_each_matched_gateways_new_addresses() {
    let (mut driver, id) = started();
    record(&driver, &id_of("ab"), &["192.168.1.20:7443"]);
    record(&driver, &id_of("ef"), &[]);
    sight(
        &mut driver,
        id,
        vec![
            sighting("a", &id_of("ab"), &["192.168.1.44:7443"]),
            sighting("b", &id_of("cd"), &["192.168.1.99:7443"]),
        ],
    );
    // One recorded gateway matched a sighting; the other matched none, and the
    // sighting of a gateway this phone is not paired with is nobody's.
    assert_eq!(title(&driver, id), "asked 1 heard 0");
    driver.pump(Duration::from_secs(15));
    assert_eq!(title(&driver, id), "asked 1 heard 1");
}

#[test]
fn a_browse_that_finds_nothing_and_no_paired_gateway_offer_the_core_nothing() {
    let (mut driver, id) = started();
    record(&driver, &id_of("ab"), &[]);
    sight(&mut driver, id, vec![]);
    assert_eq!(title(&driver, id), "asked 0 heard 0");

    // A sighting that carries no id the rule can compare is nobody's.
    sight(
        &mut driver,
        id,
        vec![wire::GatewaySighting {
            service_name: format!("centraid-gateway-{}", &id_of("ab")[..8]),
            txt: Default::default(),
            addresses: vec!["192.168.1.44:7443".to_owned()],
        }],
    );
    assert_eq!(title(&driver, id), "asked 0 heard 0");

    // With no paired gateway there is nothing to follow.
    let (mut driver, id) = started();
    sight(
        &mut driver,
        id,
        vec![sighting("a", &id_of("ab"), &["192.168.1.44:7443"])],
    );
    assert_eq!(title(&driver, id), "asked 0 heard 0");
}

#[test]
fn a_browse_is_asked_for_once_and_ended_on_request() {
    let mut follow = Rediscovery::default();
    let on = follow.start();
    assert_eq!(on.len(), 1);
    assert!(follow.start().is_empty(), "a second start asks nothing");
    assert!(follow.browsing());
    let off = follow.stop();
    assert!(matches!(
        off[0].kind,
        Some(wire::effect::Kind::BrowseGateways(wire::BrowseGateways {
            on: false,
            ..
        }))
    ));
    assert!(follow.stop().is_empty());
    // Sightings that arrive after the browse ended are not acted on.
    assert_eq!(follow.refreshed(), 0);
}
