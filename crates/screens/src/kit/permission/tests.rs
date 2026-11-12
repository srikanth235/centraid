use super::*;

const EN: Locale = Locale::En;

#[test]
fn every_resource_says_every_state_it_can_receive_in_a_sentence_of_its_own() {
    let mut all = Vec::new();
    for resource in Resource::ALL {
        assert!(
            !resource.receives().is_empty(),
            "{resource:?} can be in no state"
        );
        for &state in resource.receives() {
            let sentence = says(EN, resource, state);
            assert!(!sentence.is_empty(), "{resource:?} {state:?} says nothing");
            assert!(
                !all.contains(&sentence),
                "{resource:?} {state:?} repeats a sentence: {sentence}"
            );
            all.push(sentence);
        }
    }
}

#[test]
fn only_a_grant_a_member_can_change_points_to_settings() {
    for resource in Resource::ALL {
        for &state in resource.receives() {
            let sentence = says(EN, resource, state);
            match state {
                // A refusal is turned on in Settings; a restriction cannot be, so it never says so.
                State::Refused => assert!(sentence.contains("Settings"), "{sentence}"),
                State::Restricted => {
                    assert!(!sentence.contains("Settings"), "{sentence}");
                    assert!(sentence.contains("does not allow"), "{sentence}");
                }
                State::NotAsked => {
                    assert!(sentence.starts_with("Centraid needs"), "{sentence}");
                    assert!(!sentence.contains("Settings"), "{sentence}");
                }
                State::Limited => {}
            }
        }
    }
}

#[test]
fn a_limited_grant_says_what_it_costs_that_resource() {
    assert!(says(EN, Resource::Photos, State::Limited).contains("selected"));
    assert!(says(EN, Resource::Calendar, State::Limited).contains("full calendar access"));
    assert!(says(EN, Resource::Contacts, State::Limited).contains("only the contacts you chose"));
    assert!(says(EN, Resource::Reminders, State::Limited).contains("full access"));
}

#[test]
fn a_refused_effect_names_its_state_and_a_plain_failure_names_none() {
    let failed = |denied, restricted, limited| wire::EffectFailed {
        denied,
        restricted,
        limited,
        ..Default::default()
    };
    assert_eq!(State::of(&failed(true, false, false)), Some(State::Refused));
    assert_eq!(
        State::of(&failed(false, true, false)),
        Some(State::Restricted)
    );
    assert_eq!(State::of(&failed(false, false, true)), Some(State::Limited));
    // Restricted outranks the rest: the phone blocks it whatever else was said.
    assert_eq!(
        State::of(&failed(true, true, false)),
        Some(State::Restricted)
    );
    assert_eq!(State::of(&failed(false, false, false)), None);
    assert_eq!(
        refusal(EN, Resource::Calendar, &failed(false, false, true)).as_deref(),
        Some(says(EN, Resource::Calendar, State::Limited).as_str())
    );
    assert_eq!(
        refusal(EN, Resource::Calendar, &failed(false, false, false)),
        None
    );
}

#[test]
fn the_camera_roll_and_notifications_answer_with_the_same_states() {
    use wire::PhotosMediaPermission as P;
    assert_eq!(State::of_photos(P::NotAsked), Some(State::NotAsked));
    assert_eq!(State::of_photos(P::Denied), Some(State::Refused));
    assert_eq!(State::of_photos(P::Restricted), Some(State::Restricted));
    assert_eq!(State::of_photos(P::Limited), Some(State::Limited));
    assert_eq!(State::of_photos(P::Granted), None);
    use wire::NotificationPermission as N;
    assert_eq!(State::of_notifications(N::NotAsked), Some(State::NotAsked));
    assert_eq!(State::of_notifications(N::Denied), Some(State::Refused));
    assert_eq!(State::of_notifications(N::Granted), None);
}
