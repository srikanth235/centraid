//! THE VAULT'S CUSTODY (#1135, wave 4, lane H2): the 24 words, the seed this
//! phone keeps beside them, and the screens that make, show, enter and restore
//! them. The shell keeps bytes (Keychain, Keystore, iCloud Keychain, Block
//! Store); every decision about them is here ([`secrets`]).
//!
//! | Screen | Route name | Machine |
//! |---|---|---|
//! | Make a vault, and its words | [`MAKE`] | [`make`] |
//! | Type the words back (restore or re-key) | [`ENTER`] | [`enter`] |
//! | Show the recovery key again | [`SHOW`] | [`show`] |
//! | A vault's own key, filed in Locker (a service) | [`FILING`] | [`filing`] |
//!
//! **The order the words are kept in is [`enrollment`]'s**: each flow is a job
//! that asks the shell for one thing at a time and takes its answer as input, so
//! the order is a state machine and not a convention. The shelf (founding a
//! vault, holding what a restore laid down, re-keying) is [`keeper::Keeper`]'s.
//!
//! **A secret reaches a view only where the screen drew it before**: the shown
//! words (`secure`, shielded by the shell) and the cells the member typed. The
//! words and the seed are in no route, no log line and no `Debug`.

use centraid_api_proto::core_v1 as wire;

use crate::Registry;
use crate::strings::{Locale, custody as words};

pub mod door;
pub mod enrollment;
pub mod enter;
pub mod filing;
pub mod keeper;
pub mod make;
pub mod secrets;
pub mod show;

pub const MAKE: &str = "words.make";
pub const ENTER: &str = "words.enter";
pub const SHOW: &str = "words.show";
/// The service that files a vault's own key in Locker after an unlock.
pub const FILING: &str = "custody.filing";

/// Every custody screen, registered under its route name, over an empty keeper
/// slot: a make says the session is still opening until a shelf is installed.
/// `secrets` is the one cache the whole runtime shares.
#[must_use]
pub fn registry(secrets: &secrets::VaultSecrets) -> Registry {
    registry_with(secrets, &keeper::KeeperSlot::new())
}

/// [`registry`] over the slot the shelf is installed in.
#[must_use]
pub fn registry_with(secrets: &secrets::VaultSecrets, keeper: &keeper::KeeperSlot) -> Registry {
    let (a, b) = (secrets.clone(), keeper.clone());
    let make = move |route: &wire::Route| make::build(&a, &b, route);
    let (a, b) = (secrets.clone(), keeper.clone());
    let enter = move |route: &wire::Route| enter::build(&a, &b, route);
    let (a, b) = (secrets.clone(), keeper.clone());
    let show = move |route: &wire::Route| show::build(&a, &b, route);
    let (a, b) = (secrets.clone(), keeper.clone());
    let filing = move |route: &wire::Route| filing::build(&a, &b, route);
    Registry::default()
        .with(MAKE, make)
        .with(ENTER, enter)
        .with(SHOW, show)
        .with(FILING, filing)
}

/// The view-less screens custody runs for as long as the runtime does.
#[must_use]
pub fn services() -> Vec<wire::Route> {
    vec![wire::Route {
        screen: FILING.to_owned(),
        args: None,
    }]
}

/// The sentence a member reads about where their recovery key is kept, from the
/// platform the shell runs on and what its synchronised store said it would do.
/// The branch is on the platform's own answer and not a build flag: a member
/// with iCloud Keychain off is on iOS and is in Android's place.
///
/// **The platforms are not symmetric and the copy says so.** Block Store hands
/// a key back only inside the new-phone setup flow, so Android's sentence says
/// when it comes back and what a member who skips that step needs.
#[must_use]
pub fn custody_sentence(
    locale: Locale,
    platform: &str,
    status: Option<&wire::SyncedSecretsStatus>,
) -> String {
    let synchronizing = status.is_some_and(|status| status.synchronizing);
    match (platform, status) {
        ("ios", Some(_)) if synchronizing => words::custody_ios(locale),
        ("ios", Some(_)) => words::custody_ios_off(locale),
        ("android", Some(_)) if synchronizing => words::custody_android(locale),
        _ => words::custody_unknown(locale),
    }
}

/// Where the key goes, in the member's words ("iCloud Keychain", "Google");
/// what the Backup tab names when it says where the key is. Empty when the
/// platform does not synchronise: there is nowhere to name.
#[must_use]
pub fn custody_place(
    locale: Locale,
    platform: &str,
    status: Option<&wire::SyncedSecretsStatus>,
) -> String {
    if !status.is_some_and(|status| status.synchronizing) {
        return String::new();
    }
    match platform {
        "ios" => words::place_ios(locale),
        "android" => words::place_android(locale),
        _ => String::new(),
    }
}

/// The routes a caller outside custody pushes: Home's vault switcher, Settings
/// and Backup, Locker's wall and the pairing screen.
pub mod routes {
    use super::{ENTER, MAKE, SHOW, wire};

    fn route(screen: &str, args: wire::route::Args) -> wire::Route {
        wire::Route {
            screen: screen.to_owned(),
            args: Some(args),
        }
    }

    /// Make a vault (and, on a phone with no key, its 24 words).
    #[must_use]
    pub fn make() -> wire::Route {
        route(
            MAKE,
            wire::route::Args::WordsMake(wire::WordsMakeRoute {}),
        )
    }

    /// Type the words back for `purpose`; a re-key names the door it came from.
    #[must_use]
    pub fn enter(purpose: wire::WordsEnterPurpose, origin: wire::WordsEnterOrigin) -> wire::Route {
        route(
            ENTER,
            wire::route::Args::WordsEnter(wire::WordsEnterRoute {
                purpose: purpose as i32,
                origin: origin as i32,
            }),
        )
    }

    /// Restore onto this phone. A phone already holding a seed restores from it
    /// with no words typed.
    #[must_use]
    pub fn restore() -> wire::Route {
        enter(
            wire::WordsEnterPurpose::Restore,
            wire::WordsEnterOrigin::Unspecified,
        )
    }

    /// Restore with the seed this phone already holds.
    #[must_use]
    pub fn restore_held() -> wire::Route {
        enter(
            wire::WordsEnterPurpose::RestoreHeld,
            wire::WordsEnterOrigin::Unspecified,
        )
    }

    /// Hand the words back to this phone's vaults: Locker's wall.
    #[must_use]
    pub fn rekey_for_locker() -> wire::Route {
        enter(
            wire::WordsEnterPurpose::Rekey,
            wire::WordsEnterOrigin::Locker,
        )
    }

    /// The same re-key from pair.laptop's NEEDS_WORDS (#1047 F5): the screen
    /// explains the words in pairing's terms.
    #[must_use]
    pub fn rekey_for_pairing() -> wire::Route {
        enter(
            wire::WordsEnterPurpose::Rekey,
            wire::WordsEnterOrigin::Pairing,
        )
    }

    /// Show the recovery key again, after the owner check.
    #[must_use]
    pub fn show() -> wire::Route {
        route(SHOW, wire::route::Args::WordsShow(wire::WordsShowRoute {}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(synchronizing: bool) -> wire::SyncedSecretsStatus {
        wire::SyncedSecretsStatus {
            synchronizing,
            restores_after_setup: true,
        }
    }

    #[test]
    fn ios_and_android_are_told_different_things_about_their_key() {
        let ios = custody_sentence(Locale::En, "ios", Some(&status(true)));
        let android = custody_sentence(Locale::En, "android", Some(&status(true)));
        assert!(ios.contains("iCloud Keychain"));
        // THE ASYMMETRY IS THE POINT: Block Store restores only in the
        // device-setup flow, so the sentence says when the key comes back and
        // what a member who skips that step needs.
        assert!(android.contains("while setting up a new one"));
        assert!(android.contains("you'll need your recovery key"));
        assert!(!android.contains("automatically"));
    }

    #[test]
    fn a_member_with_icloud_keychain_off_is_told_the_key_is_only_here() {
        let off = custody_sentence(Locale::En, "ios", Some(&status(false)));
        assert!(off.contains("only on this iPhone"));
        assert!(custody_place(Locale::En, "ios", Some(&status(false))).is_empty());
    }

    #[test]
    fn a_platform_that_will_not_say_gets_the_unknown_sentence() {
        for (platform, status) in [("android", Some(status(false))), ("ios", None), ("", None)] {
            let sentence = custody_sentence(Locale::En, platform, status.as_ref());
            assert!(sentence.contains("Save a copy"), "{platform}: {sentence}");
        }
    }

    #[test]
    fn the_place_names_where_the_key_goes() {
        assert_eq!(
            custody_place(Locale::En, "ios", Some(&status(true))),
            "iCloud Keychain"
        );
        assert_eq!(
            custody_place(Locale::En, "android", Some(&status(true))),
            "Google"
        );
    }
}
