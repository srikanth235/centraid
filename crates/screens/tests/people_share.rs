//! Share one person (#1185, take out): the page's More row asks the owner check, and only a pass
//! hands the person to the OS as one vCard.

mod people_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::people::{self, routes};
use people_support::*;
use wire::people_person_event::Kind as P;

fn kinds(d: &centraid_screens::testing::Driver) -> Vec<wire::effect::Kind> {
    d.effects
        .iter()
        .filter_map(|request| request.effect.as_ref()?.kind.clone())
        .collect()
}

fn share_requested(d: &mut centraid_screens::testing::Driver, i: u64) {
    d.send(
        i,
        wire::screen_event::Kind::PeoplePerson(wire::PeoplePersonEvent {
            kind: Some(P::ShareRequested(
                wire::people_person_event::ShareRequested {},
            )),
        }),
    );
}

#[test]
fn one_person_is_shared_as_one_vcard_only_after_the_owner_check() {
    let mut d = clean();
    let ada = person(&d, "Ada Lovelace");
    let _other = person(&d, "Grace Hopper");
    begin(&mut d);
    let i = d.push(people::TAB, routes::person(&ada, "Ada Lovelace", false));
    let chrome = person_state(d.view(i)).chrome.clone().unwrap();
    assert_eq!(chrome.share, "Share");
    d.effects.clear();
    share_requested(&mut d, i);
    assert!(matches!(
        kinds(&d).as_slice(),
        [wire::effect::Kind::OwnerCheck(check)] if check.ask
    ));

    d.answer_effect(wire::effect_result::Outcome::OwnerChecked(
        wire::OwnerChecked {
            available: true,
            outcome: wire::owner_checked::Outcome::Succeeded as i32,
            ..wire::OwnerChecked::default()
        },
    ));
    let Some(wire::effect::Kind::ShareBytes(share)) = kinds(&d).into_iter().last() else {
        panic!(
            "the share sheet was asked for: {:?}",
            person_state(d.view(i)).status
        );
    };
    assert_eq!(share.name, "Ada Lovelace.vcf");
    assert_eq!(share.media_type, "text/vcard");
    let card = String::from_utf8_lossy(&share.content);
    assert!(card.contains("Ada Lovelace"));
    assert!(!card.contains("Grace Hopper"), "one person, not everyone");
    assert_eq!(card.matches("BEGIN:VCARD").count(), 1);
}

#[test]
fn a_refused_check_shares_nothing_and_says_why() {
    let mut d = clean();
    let ada = person(&d, "Ada Lovelace");
    begin(&mut d);
    let i = d.push(people::TAB, routes::person(&ada, "Ada Lovelace", false));
    d.effects.clear();
    share_requested(&mut d, i);
    d.answer_effect(wire::effect_result::Outcome::OwnerChecked(
        wire::OwnerChecked {
            outcome: wire::owner_checked::Outcome::Failed as i32,
            ..wire::OwnerChecked::default()
        },
    ));
    assert!(
        !kinds(&d)
            .iter()
            .any(|kind| matches!(kind, wire::effect::Kind::ShareBytes(_)))
    );
    let status = person_state(d.view(i)).status.clone().expect("a sentence");
    assert!(status.refused);
}
